/** Refuse obvious transport/binary/secrets, never log or truncate entered content. */
export function isSafeDraftText(value: string): boolean {
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
    && !/(?:data:[^\s,]*[;,]|blob:https?:|%PDF-|-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----)/i.test(value)
    && !/(?:[?&](?:token|access_token|signature|sig|x-amz-signature|x-goog-signature)=|\bBearer\s+[A-Za-z0-9._-]{16,})/i.test(value)
    && !/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/.test(value)
    && !/(?:^|\s)(?:JVBERi0|iVBORw0KGgo|\/9j\/)[A-Za-z0-9+/=]{40,}/.test(value);
}
