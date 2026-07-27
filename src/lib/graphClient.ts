import { isConfirmedInitialDispatchEmail } from "./emailParser";

export type GraphEmail = {
  id: string;
  subject: string;
  body: { content: string; contentType: string };
  from: { emailAddress: { address: string; name: string } };
  receivedDateTime: string;
  toRecipients: Array<{
    emailAddress: { address: string; name: string };
  }>;
};

type TokenCache = {
  token: string;
  expiresAt: number;
};

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const TOKEN_REFRESH_SKEW_MS = 60_000;
const GRAPH_REQUEST_TIMEOUT_MS = 15_000;
const INTAKE_BATCH_SIZE = 25;
const INTAKE_PAGE_SIZE = 50;
const INTAKE_MAX_PAGES = 5;

let tokenCache: TokenCache | null = null;

const outlookConfig = () => ({
  tenantId: process.env.OUTLOOK_TENANT_ID || "",
  clientId: process.env.OUTLOOK_CLIENT_ID || "",
  clientSecret: process.env.OUTLOOK_CLIENT_SECRET || "",
  userEmail: process.env.OUTLOOK_USER_EMAIL || "",
  folderName: process.env.OUTLOOK_FOLDER_NAME || "7-Eleven Dispatch",
});

const intakeStartAt = () => {
  const raw = process.env.EMAIL_INTAKE_START_AT || "";
  if (!raw) {
    throw new Error("EMAIL_INTAKE_START_AT is required before email intake can run");
  }

  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("EMAIL_INTAKE_START_AT must be a valid ISO timestamp");
  }

  return date.toISOString();
};

const graphHeaders = (accessToken: string) => ({
  Authorization: `Bearer ${accessToken}`,
  "Content-Type": "application/json",
});

const fetchWithTimeout = async (
  url: string,
  init: RequestInit,
  operation: string,
): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GRAPH_REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`${operation} timed out after ${GRAPH_REQUEST_TIMEOUT_MS / 1000} seconds`);
    }
    throw new Error(`${operation} failed due to a network error`);
  } finally {
    clearTimeout(timeout);
  }
};

const assertResponseOk = (res: Response, operation: string) => {
  if (!res.ok) {
    throw new Error(`${operation} failed with HTTP ${res.status}`);
  }
};

export async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt - TOKEN_REFRESH_SKEW_MS > now) {
    return tokenCache.token;
  }

  const { tenantId, clientId, clientSecret } = outlookConfig();
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error("Graph authentication is not configured");
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "https://graph.microsoft.com/.default",
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetchWithTimeout(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
    "Graph token request",
  );
  assertResponseOk(res, "Graph token request");

  const data = await res.json() as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new Error("Graph token response did not include an access token");
  }

  tokenCache = {
    token: data.access_token,
    expiresAt: now + ((data.expires_in || 3600) * 1000),
  };
  return data.access_token;
}

export async function getOrCreateFolder(accessToken: string): Promise<string> {
  const { userEmail, folderName } = outlookConfig();
  if (!accessToken) throw new Error("Graph access token is unavailable");
  if (!userEmail) throw new Error("OUTLOOK_USER_EMAIL is not configured");

  const listUrl = `${GRAPH_BASE_URL}/users/${encodeURIComponent(userEmail)}/mailFolders?$select=id,displayName&$top=100`;
  const listRes = await fetchWithTimeout(
    listUrl,
    { headers: graphHeaders(accessToken) },
    "Graph folder list request",
  );
  assertResponseOk(listRes, "Graph folder list request");

  const listData = await listRes.json() as { value?: Array<{ id: string; displayName: string }> };
  const existing = (listData.value || []).find(folder => folder.displayName === folderName);
  if (existing) return existing.id;

  const createRes = await fetchWithTimeout(
    `${GRAPH_BASE_URL}/users/${encodeURIComponent(userEmail)}/mailFolders`,
    {
      method: "POST",
      headers: graphHeaders(accessToken),
      body: JSON.stringify({ displayName: folderName }),
    },
    "Graph folder create request",
  );
  assertResponseOk(createRes, "Graph folder create request");

  const created = await createRes.json() as { id?: string };
  if (!created.id) {
    throw new Error("Graph folder create response did not include a folder ID");
  }
  return created.id;
}

export async function getUnreadDispatchEmails(accessToken: string): Promise<GraphEmail[]> {
  const { userEmail } = outlookConfig();
  if (!accessToken) throw new Error("Graph access token is unavailable");
  if (!userEmail) throw new Error("OUTLOOK_USER_EMAIL is not configured");

  const since = intakeStartAt();
  const filter = `receivedDateTime ge ${since} and isRead eq false`;

  const params = new URLSearchParams({
    "$filter": filter,
    "$select": "id,subject,body,from,receivedDateTime,toRecipients",
    "$orderby": "receivedDateTime desc",
    "$top": String(INTAKE_PAGE_SIZE),
  });

  const queue: GraphEmail[] = [];
  let nextUrl: string | null =
    `${GRAPH_BASE_URL}/users/${encodeURIComponent(userEmail)}/mailFolders/inbox/messages?${params.toString()}`;

  for (
    let page = 0;
    nextUrl && page < INTAKE_MAX_PAGES && queue.length < INTAKE_BATCH_SIZE;
    page += 1
  ) {
    const res = await fetchWithTimeout(
      nextUrl,
      { headers: graphHeaders(accessToken) },
      "Graph unread messages request",
    );
    assertResponseOk(res, "Graph unread messages request");

    const data = await res.json() as {
      value?: GraphEmail[];
      "@odata.nextLink"?: string;
    };
    for (const email of data.value || []) {
      if (isConfirmedInitialDispatchEmail(email)) queue.push(email);
      if (queue.length >= INTAKE_BATCH_SIZE) break;
    }
    nextUrl = data["@odata.nextLink"] || null;
  }

  return queue.sort((a, b) => {
    const timeDifference =
      new Date(a.receivedDateTime).getTime() - new Date(b.receivedDateTime).getTime();
    return timeDifference || a.id.localeCompare(b.id);
  });
}

export async function markEmailRead(accessToken: string, messageId: string): Promise<void> {
  const { userEmail } = outlookConfig();
  if (!accessToken) throw new Error("Graph access token is unavailable");
  if (!userEmail) throw new Error("OUTLOOK_USER_EMAIL is not configured");
  if (!messageId) throw new Error("Cannot mark an email read without a message ID");

  const res = await fetchWithTimeout(
    `${GRAPH_BASE_URL}/users/${encodeURIComponent(userEmail)}/messages/${encodeURIComponent(messageId)}`,
    {
      method: "PATCH",
      headers: graphHeaders(accessToken),
      body: JSON.stringify({ isRead: true }),
    },
    "Graph mark-read request",
  );
  assertResponseOk(res, "Graph mark-read request");
}

export async function moveEmailToFolder(
  accessToken: string,
  messageId: string,
  folderId: string,
): Promise<void> {
  const { userEmail } = outlookConfig();
  if (!accessToken) throw new Error("Graph access token is unavailable");
  if (!userEmail) throw new Error("OUTLOOK_USER_EMAIL is not configured");
  if (!messageId) throw new Error("Cannot move an email without a message ID");
  if (!folderId) throw new Error("Cannot move an email without a destination folder");

  const res = await fetchWithTimeout(
    `${GRAPH_BASE_URL}/users/${encodeURIComponent(userEmail)}/messages/${encodeURIComponent(messageId)}/move`,
    {
      method: "POST",
      headers: graphHeaders(accessToken),
      body: JSON.stringify({ destinationId: folderId }),
    },
    "Graph move-message request",
  );
  assertResponseOk(res, "Graph move-message request");
}

export async function sendEmail(
  accessToken: string,
  to: string[],
  subject: string,
  body: string,
): Promise<void> {
  const { userEmail } = outlookConfig();
  const recipients = to.map(email => email.trim()).filter(Boolean);
  if (!accessToken) throw new Error("Graph access token is unavailable");
  if (!userEmail) throw new Error("OUTLOOK_USER_EMAIL is not configured");
  if (recipients.length === 0 || !subject || !body) {
    throw new Error("Graph email request is missing recipients, subject, or body");
  }

  const res = await fetchWithTimeout(
    `${GRAPH_BASE_URL}/users/${encodeURIComponent(userEmail)}/sendMail`,
    {
      method: "POST",
      headers: graphHeaders(accessToken),
      body: JSON.stringify({
        message: {
          subject,
          body: {
            contentType: "Text",
            content: body,
          },
          toRecipients: recipients.map(address => ({
            emailAddress: { address },
          })),
        },
        saveToSentItems: true,
      }),
    },
    "Graph send-mail request",
  );
  assertResponseOk(res, "Graph send-mail request");
}
