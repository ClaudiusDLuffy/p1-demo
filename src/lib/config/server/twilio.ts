import process from "node:process";
import { ConfigurationError, optionalGroup, readValue, requiredValue, type EnvironmentValues } from "../shared";
import { assertProviderEnvironment } from "./appEnvironment";
export type TwilioConfig = { accountSid: string; username: string; password: string; messagingServiceSid: string; from: string };
const names = ["TWILIO_ACCOUNT_SID", "TWILIO_API_KEY_SID", "TWILIO_API_KEY_SECRET", "TWILIO_AUTH_TOKEN", "TWILIO_MESSAGING_SERVICE_SID", "TWILIO_FROM_NUMBER"] as const;
export function getTwilioConfig(values: EnvironmentValues = process.env) {
  return optionalGroup("twilio", names, values, (): TwilioConfig => {
    const accountSid = requiredValue(values, names[0], "twilio", 34);
    const key = readValue(values, names[1]); const keySecret = readValue(values, names[2]);
    if (Boolean(key) !== Boolean(keySecret)) throw new ConfigurationError("CONFIG_INCOMPLETE", "twilio", [names[1], names[2]]);
    const username = key || accountSid;
    const password = key ? requiredValue(values, names[2], "twilio", 512) : requiredValue(values, names[3], "twilio", 512);
    const messagingServiceSid = readValue(values, names[4]); const from = readValue(values, names[5]);
    if (!messagingServiceSid && !from) throw new ConfigurationError("CONFIG_INCOMPLETE", "twilio", [names[4], names[5]]);
    if (!/^AC[0-9a-f]{32}$/i.test(accountSid) || (key && !/^SK[0-9a-f]{32}$/i.test(key))
      || (messagingServiceSid ? !/^MG[0-9a-f]{32}$/i.test(messagingServiceSid) : !/^\+[1-9][0-9]{7,14}$/.test(from))) {
      throw new ConfigurationError("CONFIG_INVALID", "twilio", [names[0], names[1], names[4], names[5]]);
    }
    assertProviderEnvironment("twilio", values);
    return { accountSid, username, password, messagingServiceSid, from };
  });
}
