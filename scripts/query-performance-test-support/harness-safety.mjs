// Local harness failure categories never include SQL, provider configuration,
// or raw exception bodies. An absent engine has no network fallback.
export const classifyHarnessFailure = (phase,error) => ({
  evidence:phase==='engine'?'UNAVAILABLE':'LOCAL_VERIFICATION_FAILED',
  phase,
  code:typeof error?.code==='string'&&/^[A-Z0-9_]{1,40}$/.test(error.code)?error.code:'LOCAL_VERIFICATION_FAILURE',
  message:phase==='engine'?'Approved isolated SQL engine unavailable; no production fallback.':
    phase==='plan'?'Isolated query-plan capture failed; no plan certification.':
      phase==='fixture'?'Deterministic isolated fixture failed; requested scale not certified.':
        'A local contract or performance verification failed; results are incomplete.',
});

export async function captureIsolatedPlan(query,sql,params=[]) {
  // Callers supply only fixed repository-owned synthetic SQL. No alternative
  // engine, remote connection, or silent BUFFERS downgrade is attempted.
  const result=await query('explain(analyze,buffers,format json) '+sql,params);
  const plan=result?.rows?.[0]?.['QUERY PLAN']?.[0];
  if(!plan?.Plan||typeof plan['Execution Time']!=='number') {
    const error=new Error('Isolated query plan was not returned');
    error.code='LOCAL_PLAN_UNAVAILABLE';throw error;
  }
  return plan;
}
