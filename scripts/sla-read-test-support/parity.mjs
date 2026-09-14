import assert from 'node:assert/strict';
import { SLA_COMPATIBILITY_POLICY } from '../../src/lib/sla/policy.ts';
import { evaluateSla } from './fixtures.mjs';

export async function verifySlaSqlParity(f, check) {
  const fixed = new Date('2026-09-10T12:00:00.000Z');
  const at = hours => new Date(fixed.getTime() + hours * 3_600_000).toISOString();
  let comparisons = 0;
  async function compare(row, now = fixed) {
    const input = [row.priority ?? null, row.dispatched_at ?? null, row.response_breach_at ?? null,
      row.resolution_breach_at ?? null, row.start_time ?? null, Number.isFinite(now.getTime()) ? now.toISOString() : null];
    const result = (await f.db.query('select * from public.evaluate_work_order_sla_v1($1,$2,$3,$4,$5,$6)', input)).rows[0];
    const expected = evaluateSla(row, now);
    assert.equal(result.due_at?.getTime() ?? null, expected.dueTime);
    assert.equal(result.breached, expected.breached);
    comparisons++;
  }
  for (const priority of [...Object.keys(SLA_COMPATIBILITY_POLICY), 'P1', ' P1 ', 'unknown', null]) {
    await check(`SLA SQL matches imported canonical legacy policy for ${priority ?? 'missing'} priority`, async () => {
      for (const hours of [-200, -24, -8, -1, 0, 1]) await compare({ priority, dispatched_at: at(hours) });
      await compare({ priority, sla_started_at: at(-100) });
    });
  }
  await check('SLA SQL every full/partial stored deadline and response-completion combination matches TypeScript', async () => {
    for (const response of [null, at(-1), at(0), at(1), at(5)]) {
      for (const resolution of [null, at(-2), at(0), at(1), at(4)]) {
        for (const started of [null, at(-2), at(2)]) {
          for (const priority of ['p1', 'p4', 'unknown']) {
            await compare({ priority, response_breach_at: response, resolution_breach_at: resolution,
              start_time: started, dispatched_at: at(-100), sla_started_at: at(20) });
          }
        }
      }
    }
  });
  await check('SLA SQL missing/invalid clock never fabricates overdue while stored due remains readable', async () => {
    await compare({ response_breach_at: at(-1), resolution_breach_at: at(4) }, new Date('invalid'));
    await compare({ priority: 'p1', dispatched_at: at(-100) }, new Date('invalid'));
  });
  await check('SLA SQL nonfinite stored timestamps never trigger fallback or hide the valid stored half', async () => {
    for (const infinite of ['infinity', '-infinity']) {
      await compare({ priority: 'p1', dispatched_at: at(-100), response_breach_at: infinite });
      await compare({ response_breach_at: infinite, resolution_breach_at: at(4) });
      await compare({ response_breach_at: at(-1), resolution_breach_at: infinite, start_time: infinite });
    }
  });
  await check('SLA SQL epoch, exact boundary, inverted pair and tied deadlines preserve headline/breach semantics', async () => {
    for (const row of [
      { response_breach_at: '1970-01-01T00:00:00Z' },
      { response_breach_at: at(0), resolution_breach_at: at(4) },
      { response_breach_at: at(4), resolution_breach_at: at(1) },
      { response_breach_at: at(1), resolution_breach_at: at(1) },
      { response_breach_at: at(1), resolution_breach_at: at(1), start_time: at(-1) },
      { response_breach_at: at(-1), start_time: at(0), priority: 'p1', dispatched_at: at(-100) },
    ]) await compare(row);
  });
  await check('SLA SQL DST and timezone offsets retain elapsed-hour legacy deadlines without anchor substitution', async () => {
    for (const dispatch of ['2026-03-08T00:00:00-05:00', '2026-11-01T00:00:00-04:00', '2026-09-10T23:59:59+12:45']) {
      for (const priority of ['p1', 'p4']) await compare({ priority, dispatched_at: dispatch, sla_started_at: at(100) });
    }
  });
  await check('SLA SQL helper evaluates one row without modifying caller input or any persisted work-order', async () => {
    const before = await f.assignment.snapshot();
    const row = Object.freeze({ priority: 'p2', response_breach_at: at(2), resolution_breach_at: null });
    await compare(row);
    assert.deepEqual(await f.assignment.snapshot(), before);
  });
  console.log(`SLA PARITY: ${comparisons} typed PostgreSQL input cases compared with the actual TypeScript evaluator.`);
}
