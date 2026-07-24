import type { GraphEmail } from "./graphClient";
import {
  detectEmailType,
  isConfirmedInitialDispatchSubject,
  parseDispatchEmail,
  type EmailType,
} from "./emailParser";

const MOCK_EMAILS: GraphEmail[] = [
  {
    id: "mock-001",
    subject: "7-Eleven Priority P2 - Emergency Work Order WOT0617474 / INC26277634 has been dispatched.",
    body: {
      contentType: "text",
      content: `Work Order WOT0617474 has been submitted with the following details:

Number: WOT0617474
Incident: INC26277634

Store Location: 7-ELEVEN STORE - 37205
Store Address: 4456 HERITAGE TRACE PKW,FORT WORTH,TX,US,76244
AFM: James Phillips
Email: James.Phillips2@7-11.com
Priority: P2 - Emergency
State: Accepted
Line of Service: Frozen Beverage - Equipment
Business Service: Slurpee and Frozen Lemonade
Category: Slurpee Machine - The only Slurpee machine in store is affected
Sub Category: One or few flavors are not dispensing
Short description: Slurpee machanie not working
Description: More than 3 type`,
    },
    from: {
      emailAddress: {
        address: "7elevenna@service-now.com",
        name: "7HELP Service Desk",
      },
    },
    receivedDateTime: new Date().toISOString(),
    toRecipients: [],
  },
  {
    id: "mock-002",
    subject: "7-Eleven Priority P1 - Critical Work Order Task WOT0448458 NTE/Quote Has Been Approved.",
    body: {
      contentType: "text",
      content: `Work Order Task WOT0448458 NTE/Quote has been approved with the following details:

Number: WOT0448458
Incident: INC25608962

Store Location: 7-ELEVEN STORE - 40988
Store Address: 1111 W. LEAGUE CITY PKWY,LEAGUE CITY,TX,US,77573
AFM: Joseph Martin
Email: Joseph.Martin@7-11.com
Priority: P1 - Critical
State: Closed Complete
Line of Service: Refrigeration
Business Service: Refrigeration equipment
Category: Standing freezer (Back of house - BOH)
Sub Category: Freezer not holding temperature/not working
Vendor: P1 Pros

Order Summary: there is ice build up temp will not go below 25%
Order Description: Best contact number: 4096559470`,
    },
    from: {
      emailAddress: {
        address: "7elevenna@service-now.com",
        name: "7HELP Service Desk",
      },
    },
    receivedDateTime: new Date().toISOString(),
    toRecipients: [],
  },
  {
    id: "mock-003",
    subject: "7-Eleven Priority P4 - Routine Work Order WOT0306198 / INC25647260 Pending Capital Approval",
    body: {
      contentType: "text",
      content: `Work Order WOT0306198 has been submitted with the following details:

Number: WOT0306198
Incident: INC25647260

Store Location: 7-ELEVEN STORE - 33275
Store Address: 5501 S BUCKNER BLVD,DALLAS,TX,US,75228
AFM: Donald Matanowski
Email: Donald.Matanowski@7-11.com
Priority: P4 - Routine
State: Work In Progress
Line of Service: IT
Business Service: IHM Tech Needed
Category: On-Site Assistance
Sub Category: Routine
Short description: this is for the slurpee job from FWKD do not dispatch
Description: this is for the slurpee job from FWKD do not dispatch`,
    },
    from: {
      emailAddress: {
        address: "7elevenna@service-now.com",
        name: "7HELP Service Desk",
      },
    },
    receivedDateTime: new Date().toISOString(),
    toRecipients: [],
  },
];

const CLASSIFICATION_CASES: Array<{
  subject: string;
  expectedType: EmailType;
  canCreate: boolean;
}> = [
  {
    subject: "Dispatch - 7-Eleven Work Order WOT0617474 / INC26277634",
    expectedType: "TYPE_DISPATCHED",
    canCreate: true,
  },
  {
    subject: "7-Eleven Work Order WOT0617474 / INC26277634 was dispatched",
    expectedType: "TYPE_DISPATCHED",
    canCreate: true,
  },
  {
    subject: "7-Eleven Work Order WOT0617474 / INC26277634 has been dispatched",
    expectedType: "TYPE_DISPATCHED",
    canCreate: true,
  },
  {
    subject: "Re: 7-Eleven Work Order WOT0617474 has been dispatched",
    expectedType: "TYPE_STATE_UPDATE",
    canCreate: false,
  },
  {
    subject: "Fw: 7-Eleven Work Order WOT0617474 has been dispatched",
    expectedType: "TYPE_STATE_UPDATE",
    canCreate: false,
  },
  {
    subject: "Fwd: WOT0617474 has been dispatched - NTE/Quote Has Been Approved",
    expectedType: "TYPE_NTE_APPROVED",
    canCreate: false,
  },
  {
    subject: "Work Order Task WOT0617474 NTE approved",
    expectedType: "TYPE_NTE_APPROVED",
    canCreate: false,
  },
  {
    subject: "Re: WOT0617474 has been dispatched - Pending Capital Approval",
    expectedType: "TYPE_CAPITAL_PENDING",
    canCreate: false,
  },
  {
    subject: "WOT0617474 projected completion updated",
    expectedType: "TYPE_STATE_UPDATE",
    canCreate: false,
  },
  {
    subject: "WOT0617474 has been approved",
    expectedType: "TYPE_STATE_UPDATE",
    canCreate: false,
  },
  {
    subject: "WOT0617474 has been dispatched - Approved",
    expectedType: "TYPE_STATE_UPDATE",
    canCreate: false,
  },
  {
    subject: "Status update: WOT0617474 dispatched",
    expectedType: "TYPE_STATE_UPDATE",
    canCreate: false,
  },
  {
    subject: "Work Order Task WOT0617474 has been assigned",
    expectedType: "TYPE_STATE_UPDATE",
    canCreate: false,
  },
  {
    subject: "WOT0617474 do not dispatch",
    expectedType: "TYPE_STATE_UPDATE",
    canCreate: false,
  },
  {
    subject: "General mailbox message",
    expectedType: "TYPE_UNKNOWN",
    canCreate: false,
  },
];

const assertEqual = (actual: unknown, expected: unknown, label: string) => {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
  }
};

export function runDeterministicEmailIntakeTests(): void {
  for (const testCase of CLASSIFICATION_CASES) {
    assertEqual(
      detectEmailType(testCase.subject),
      testCase.expectedType,
      `classification for "${testCase.subject}"`,
    );
    assertEqual(
      isConfirmedInitialDispatchSubject(testCase.subject),
      testCase.canCreate,
      `creation eligibility for "${testCase.subject}"`,
    );
  }

  const dispatched = parseDispatchEmail(MOCK_EMAILS[0]);
  assertEqual(dispatched.emailType, "TYPE_DISPATCHED", "direct dispatch type");
  assertEqual(dispatched.state, "TX", "store state");
  assertEqual(dispatched.functionalState, "Accepted", "functional state");
  assertEqual(dispatched.parseConfidence, "high", "direct dispatch confidence");

  const nte = parseDispatchEmail(MOCK_EMAILS[1]);
  assertEqual(nte.emailType, "TYPE_NTE_APPROVED", "NTE type");

  const capital = parseDispatchEmail(MOCK_EMAILS[2]);
  assertEqual(capital.emailType, "TYPE_CAPITAL_PENDING", "capital type");
  assertEqual(capital.doNotDispatch, true, "capital do-not-dispatch detection");
}

export async function runMockIntakeTest(): Promise<void> {
  runDeterministicEmailIntakeTests();
  console.log(`Email intake tests passed (${CLASSIFICATION_CASES.length * 2 + 7} assertions)`);
}

export { MOCK_EMAILS };
