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
  if (!raw) return "";

  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) {
    console.error("EMAIL_INTAKE_START_AT is invalid. Use an ISO timestamp, for example 2026-07-07T14:39:35.162Z");
    return "";
  }

  return date.toISOString();
};

const graphHeaders = (accessToken: string) => ({
  Authorization: `Bearer ${accessToken}`,
  "Content-Type": "application/json",
});

export async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt - TOKEN_REFRESH_SKEW_MS > now) {
    return tokenCache.token;
  }

  const { tenantId, clientId, clientSecret } = outlookConfig();
  if (!tenantId || !clientId || !clientSecret) {
    console.error("Graph auth is missing Outlook environment variables");
    return "";
  }

  try {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      scope: "https://graph.microsoft.com/.default",
      client_id: clientId,
      client_secret: clientSecret,
    });

    const res = await fetch(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      },
    );

    if (!res.ok) {
      console.error("Graph token request failed", res.status, await res.text());
      return "";
    }

    const data = await res.json() as { access_token?: string; expires_in?: number };
    if (!data.access_token) {
      console.error("Graph token response did not include access_token");
      return "";
    }

    tokenCache = {
      token: data.access_token,
      expiresAt: now + ((data.expires_in || 3600) * 1000),
    };
    return data.access_token;
  } catch (err) {
    console.error("Graph token request error", err);
    return "";
  }
}

export async function getOrCreateFolder(accessToken: string): Promise<string> {
  const { userEmail, folderName } = outlookConfig();
  if (!accessToken || !userEmail) return "";

  try {
    const listUrl = `${GRAPH_BASE_URL}/users/${encodeURIComponent(userEmail)}/mailFolders?$select=id,displayName&$top=100`;
    const listRes = await fetch(listUrl, { headers: graphHeaders(accessToken) });
    if (!listRes.ok) {
      console.error("Graph folder list failed", listRes.status, await listRes.text());
      return "";
    }

    const listData = await listRes.json() as { value?: Array<{ id: string; displayName: string }> };
    const existing = (listData.value || []).find(folder => folder.displayName === folderName);
    if (existing) return existing.id;

    const createRes = await fetch(`${GRAPH_BASE_URL}/users/${encodeURIComponent(userEmail)}/mailFolders`, {
      method: "POST",
      headers: graphHeaders(accessToken),
      body: JSON.stringify({ displayName: folderName }),
    });
    if (!createRes.ok) {
      console.error("Graph folder create failed", createRes.status, await createRes.text());
      return "";
    }

    const created = await createRes.json() as { id?: string };
    return created.id || "";
  } catch (err) {
    console.error("Graph folder lookup error", err);
    return "";
  }
}

export async function getUnreadDispatchEmails(accessToken: string): Promise<GraphEmail[]> {
  const { userEmail } = outlookConfig();
  if (!accessToken || !userEmail) return [];

  const since = intakeStartAt();
  if (!since) {
    console.error("EMAIL_INTAKE_START_AT is required before email intake can process mailbox messages");
    return [];
  }

  const filter = `receivedDateTime ge ${since} and isRead eq false`;

  const params = new URLSearchParams({
    "$filter": filter,
    "$select": "id,subject,body,from,receivedDateTime,toRecipients",
    "$orderby": "receivedDateTime desc",
    "$top": "100",
  });

  try {
    const res = await fetch(`${GRAPH_BASE_URL}/users/${encodeURIComponent(userEmail)}/mailFolders/inbox/messages?${params.toString()}`, {
      headers: graphHeaders(accessToken),
    });
    if (!res.ok) {
      console.error("Graph unread messages request failed", res.status, await res.text());
      return [];
    }

    const data = await res.json() as { value?: GraphEmail[] };
    return (data.value || []).filter(email => {
      const subject = (email.subject || "").toLowerCase();
      const from = (email.from?.emailAddress?.address || "").toLowerCase();
      return (
        subject.includes("work order") ||
        subject.includes("wot") ||
        subject.includes("fwkd") ||
        from === "7elevenna@service-now.com" ||
        from === "dispatch@7-eleven.com" ||
        from === "workorders@7-eleven.com"
      );
    });
  } catch (err) {
    console.error("Graph unread messages error", err);
    return [];
  }
}

export async function markEmailRead(accessToken: string, messageId: string): Promise<void> {
  const { userEmail } = outlookConfig();
  if (!accessToken || !userEmail || !messageId) return;

  try {
    const res = await fetch(`${GRAPH_BASE_URL}/users/${encodeURIComponent(userEmail)}/messages/${encodeURIComponent(messageId)}`, {
      method: "PATCH",
      headers: graphHeaders(accessToken),
      body: JSON.stringify({ isRead: true }),
    });
    if (!res.ok) {
      console.error("Graph mark read failed", res.status, await res.text());
    }
  } catch (err) {
    console.error("Graph mark read error", err);
  }
}

export async function moveEmailToFolder(
  accessToken: string,
  messageId: string,
  folderId: string,
): Promise<void> {
  const { userEmail } = outlookConfig();
  if (!accessToken || !userEmail || !messageId || !folderId) return;

  try {
    const res = await fetch(`${GRAPH_BASE_URL}/users/${encodeURIComponent(userEmail)}/messages/${encodeURIComponent(messageId)}/move`, {
      method: "POST",
      headers: graphHeaders(accessToken),
      body: JSON.stringify({ destinationId: folderId }),
    });
    if (!res.ok) {
      console.error("Graph move message failed", res.status, await res.text());
    }
  } catch (err) {
    console.error("Graph move message error", err);
  }
}
