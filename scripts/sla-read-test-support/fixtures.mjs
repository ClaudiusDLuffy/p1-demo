import assert from 'node:assert/strict';
import { createDatabase, applyThrough, createFixtures } from '../receiving-dispatch-test-support/fixtures.mjs';
import { evaluateSla } from '../../src/lib/sla/evaluation.ts';

export { createDatabase, applyThrough, evaluateSla };
export const helperSignature = 'public.evaluate_work_order_sla_v1(text,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone)';
export const rpcNames = ['get_portal_navigation_summary', 'list_work_orders_table_page', 'list_work_orders_page'];

export async function slaFixtures(db) {
  const f = await createFixtures(db);
  let sequence = 0;
  const clock = async () => (await db.query('select now() value')).rows[0].value;
  async function workOrder(patch = {}) {
    const id = `SYNTHETIC-SLA-${String(++sequence).padStart(5, '0')}`;
    const row = { priority: 'p1', status: 'assigned', contractor_id: f.actors.contractor,
      dispatched_at: null, response_breach_at: null, resolution_breach_at: null, start_time: null, ...patch };
    const keys = Object.keys(row);
    assert.ok(keys.every(key => ['priority', 'status', 'contractor_id', 'dispatched_at', 'response_breach_at',
      'resolution_breach_at', 'start_time', 'sla_started_at', 'deleted_at', 'created_at'].includes(key)));
    await db.query(`insert into public.work_orders(id,${keys.join(',')}) values($1,${keys.map((_, index) => `$${index + 2}`).join(',')})`, [id, ...Object.values(row)]);
    return (await db.query('select * from public.work_orders where id=$1', [id])).rows[0];
  }
  const rows = () => db.query("select * from public.work_orders where id like 'SYNTHETIC-SLA-%' order by id").then(result => result.rows);
  const summary = (actor = f.actors.mgr, role = 'authenticated') => f.as(role, actor,
    tx => tx.query('select public.get_portal_navigation_summary() result, now() evaluated_at')).then(result => result.rows[0]);
  const page = (options = {}) => f.as(options.role ?? 'authenticated', options.actor ?? f.actors.mgr, tx => tx.query(`
    select public.list_work_orders_table_page(p_scope=>$1,p_sort_column=>$2,p_sort_direction=>$3,p_sla_filter=>$4,
      p_limit=>$5,p_cursor=>$6,p_search=>$7,p_contractor_id=>$8) result,now() evaluated_at`,
  [options.scope ?? 'all', options.sort ?? 'sla', options.direction ?? 'asc', options.overdue ? 'overdue' : null,
    options.limit ?? 25, options.cursor ?? null, options.search ?? 'SYNTHETIC-SLA-', options.contractor ?? null])).then(result => result.rows[0]);
  const legacyPage = (options = {}) => f.as(options.role ?? 'authenticated', options.actor ?? f.actors.mgr, tx => tx.query(`
    select public.list_work_orders_page(p_scope=>$1,p_sort=>$2,p_limit=>$3,p_cursor=>$4,p_search=>$5,p_contractor_id=>$6)
      result,now() evaluated_at`, [options.scope ?? 'all', options.sort ?? 'sla_due', options.limit ?? 25,
    options.cursor ?? null, options.search ?? 'SYNTHETIC-SLA-', options.contractor ?? null])).then(result => result.rows[0]);
  const definitions = async () => (await db.query(`select p.proname,p.oid::regprocedure::text signature,p.prosecdef,p.provolatile,
    p.proconfig,p.proacl,pg_get_functiondef(p.oid) definition from pg_proc p where p.pronamespace='public'::regnamespace and p.proname=any($1)
    order by p.proname`, [rpcNames])).rows;
  const model = (row, now) => evaluateSla(Object.fromEntries(Object.entries(row).map(([key, value]) =>
    [key, value instanceof Date ? value.toISOString() : value])), now);
  return { ...f, clock, workOrder, rows, summary, page, legacyPage, definitions, model };
}

export async function reproduceSlaReadDivergence(f, check) {
  const now = await f.clock();
  const at = hours => new Date(now.getTime() + hours * 3_600_000).toISOString();
  const legacy = await f.workOrder({ dispatched_at: at(-10) });
  const responded = await f.workOrder({ response_breach_at: at(-1), resolution_breach_at: at(5), start_time: at(-2) });
  await check('pre0142 navigation omits breached legacy fallback despite canonical display', async () => {
    const result = await f.summary();
    assert.equal(result.result.slaBreachedCount, 0);
    assert.equal(f.model(legacy, result.evaluated_at).breached, true);
  });
  await check('pre0142 table marks completed response overdue despite future resolution', async () => {
    const result = await f.page({ overdue: true });
    assert.ok(result.result.items.some(row => row.id === responded.id));
    assert.equal(f.model(responded, result.evaluated_at).breached, false);
  });
  await check('pre0142 both live pagination RPCs sort missing legacy deadlines behind stored deadlines', async () => {
    for (const read of [f.page, f.legacyPage]) {
      const result = await read();
      assert.equal(result.result.items[0].id, responded.id);
      assert.ok(f.model(legacy, result.evaluated_at).dueTime < f.model(responded, result.evaluated_at).dueTime);
    }
  });
  return { legacy, responded };
}
