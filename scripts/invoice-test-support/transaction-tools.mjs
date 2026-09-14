import assert from 'node:assert/strict';

export async function rejectFinancialCall(run, codes = ['PT409', '22023', '42501', '23514', 'P0002']) {
  await assert.rejects(run, error => codes.includes(error.code), 'The complete financial command must fail');
}

// Actual PostgreSQL AFTER triggers force failure after the selected write. They
// exist only in the disposable engine, never in deployed functions/migrations.
export async function withFinancialWriteFailure(db, { table, operation, condition = 'true' }, run) {
  assert.ok(['invoices', 'invoice_lines', 'staff_invoice_sources', 'work_orders', 'activities', 'invoice_financial_operations',
    'staff_invoice_number_series', 'staff_invoice_default_series'].includes(table));
  assert.ok(['insert', 'update', 'delete'].includes(operation));
  assert.ok(/^(?:true|new\.position = [1-9][0-9]*|new\.state = '(?:submitted|revised)'|new\.deleted_at is not null)$/.test(condition));
  await db.exec(`create or replace function pg_temp.fail_financial_fixture_write()
    returns trigger language plpgsql as $$ begin
      raise exception 'Synthetic financial post-write failure' using errcode='P0001';
    end $$;
    create trigger invoice_fixture_failure after ${operation} on public.${table}
      for each row when (${condition}) execute function pg_temp.fail_financial_fixture_write();`);
  try { await run(); }
  finally { await db.exec(`drop trigger invoice_fixture_failure on public.${table}`); }
}

export async function assertRawFinancialDenied({ as, actor, role = 'authenticated', query, values = [], snapshot }) {
  const before = await snapshot();
  try {
    const result = await as(role, actor, tx => tx.query(query, values));
    assert.equal(result.rows.length, 0, 'Invisible RLS updates may affect zero rows; a denied write must not return a row');
  } catch (error) {
    assert.ok(['42501', '23514', 'PT409'].includes(error.code), `Expected financial authorization denial, received ${error.code}`);
  }
  assert.deepEqual(await snapshot(), before, 'Denied raw mutation must leave the complete document unchanged');
}
