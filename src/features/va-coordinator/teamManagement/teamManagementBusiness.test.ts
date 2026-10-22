import assert from "node:assert/strict";
import test from "node:test";
import { canManageVaCoordinatorTeams, prepareSaveVaCoordinatorTeam } from "./teamManagementBusiness";
import type { VaCoordinatorTeamManagement } from "./contracts";

const directory: VaCoordinatorTeamManagement = {
  teams: [],
  coordinators: [{ id: "11111111-1111-4111-8111-111111111111", name: "Synthetic VA", active: true }],
  technicians: [{ id: "22222222-2222-4222-8222-222222222222", name: "Synthetic Tech", company: "Synthetic Company", active: true }],
};

test("VA team administration is available only to manager and back-office roles", () => {
  assert.equal(canManageVaCoordinatorTeams("manager"), true);
  assert.equal(canManageVaCoordinatorTeams("back_office"), true);
  for (const role of ["dispatcher", "contractor", "va_coordinator", null, undefined]) {
    assert.equal(canManageVaCoordinatorTeams(role), false);
  }
});

test("prepares a normalized, deduplicated team configuration from eligible roster profiles", () => {
  assert.deepEqual(prepareSaveVaCoordinatorTeam({
    teamId: null, name: "  Operations East  ",
    coordinatorProfileIds: [directory.coordinators[0].id, directory.coordinators[0].id],
    technicianProfileIds: [directory.technicians[0].id],
  }, directory), {
    p_team_id: null, p_name: "Operations East",
    p_coordinator_profile_ids: [directory.coordinators[0].id],
    p_technician_profile_ids: [directory.technicians[0].id],
  });
});

test("does not save empty team names or profiles outside active assignment options", () => {
  assert.throws(() => prepareSaveVaCoordinatorTeam({
    teamId: null, name: "  ", coordinatorProfileIds: [], technicianProfileIds: [],
  }, directory), /team name/);
  assert.throws(() => prepareSaveVaCoordinatorTeam({
    teamId: null, name: "Valid", coordinatorProfileIds: [], technicianProfileIds: ["33333333-3333-4333-8333-333333333333"],
  }, directory), /unavailable technicians/);
});
