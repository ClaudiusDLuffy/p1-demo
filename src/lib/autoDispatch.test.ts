import assert from "node:assert/strict";
import test from "node:test";
import {
  detectDispatchTerritory,
  detectDispatchTrade,
  requiresManualContractorAssignment,
  resolveContractor,
} from "./autoDispatch";
import type { ParsedWorkOrder } from "./emailParser";

const parsed = (overrides: Partial<ParsedWorkOrder>): ParsedWorkOrder => ({
  emailType: "TYPE_DISPATCHED",
  parseConfidence: "high",
  wotId: "WOT0000001",
  fwkdId: null,
  incidentId: null,
  storeNumber: "12345",
  storeLocation: null,
  summary: "Test dispatch",
  description: "Test dispatch",
  priority: "p2",
  afmName: null,
  afmEmail: null,
  city: "Dallas",
  state: "TX",
  address: "100 Main St, Dallas, TX",
  nte: null,
  lineOfService: "HVAC",
  businessService: "HVAC",
  category: "AC unit",
  subCategory: null,
  functionalState: "Dispatched",
  vendor: null,
  doNotDispatch: false,
  emailSource: "test",
  rawSubject: "Test dispatch",
  rawBody: "Test dispatch",
  ...overrides,
});

test("detects the specific EMS route before general HVAC", () => {
  assert.equal(
    detectDispatchTrade(parsed({
      lineOfService: "EMS - HVAC",
      businessService: "HVAC",
    })),
    "ems",
  );
});

test("maps DFW cities to the prepared Dallas territory", () => {
  assert.deepEqual(
    detectDispatchTerritory(parsed({ city: "Fort Worth" })),
    ["Dallas", "DFW"],
  );
});

test("does not treat every Texas city as DFW", () => {
  assert.deepEqual(
    detectDispatchTerritory(parsed({
      city: "Austin",
      address: "100 Main St, Austin, TX",
    })),
    ["Texas", "TX"],
  );
});

test("requires manual assignment for every Texas and Florida call", async () => {
  const manualCalls = [
    parsed({ city: "Dallas", lineOfService: "HVAC" }),
    parsed({ city: "Houston", lineOfService: "Refrigeration" }),
    parsed({ city: "Fort Worth", lineOfService: "EMS" }),
    parsed({ state: "FL", city: "Tampa", lineOfService: "HVAC" }),
    parsed({ state: "FL", city: "Orlando", lineOfService: "Refrigeration" }),
    parsed({ state: "FL", city: "Miami", lineOfService: "Ice" }),
  ];

  for (const workOrder of manualCalls) {
    const state = workOrder.state;
    assert.equal(requiresManualContractorAssignment(workOrder), true);
    assert.deepEqual(await resolveContractor(workOrder), {
      contractorId: null,
      reason: `manual assignment required for ${state}`,
    });
  }

  assert.equal(
    requiresManualContractorAssignment(parsed({ state: "VA", city: "Virginia Beach" })),
    false,
  );
});

test("retains Slurpee as the dedicated frozen beverage route", () => {
  assert.equal(
    detectDispatchTrade(parsed({
      lineOfService: "Frozen Beverage - Equipment",
      businessService: "Slurpee and Frozen Lemonade",
    })),
    "slurpee",
  );
});

test("matches ice as a standalone trade without matching the end of service", () => {
  assert.equal(
    detectDispatchTrade(parsed({
      lineOfService: "Food Service",
      businessService: "Hot food",
      category: "Roller grill",
    })),
    null,
  );
  assert.equal(
    detectDispatchTrade(parsed({
      lineOfService: "Ice",
      businessService: "Ice merchandiser",
      category: "Ice machine",
    })),
    "ice",
  );
});
