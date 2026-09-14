// Read-only final-schema metadata. PUBLIC is ACL grantee 0, not a login role.
// @ts-check
/** @typedef {{query(sql: string, parameters?: readonly unknown[]): Promise<{rows: Record<string, unknown>[]}>}} CatalogPort */
/** @param {CatalogPort} db */
export async function inventoryApplicationAcl(db) {
  const queries = {
    tables: `select c.oid::integer oid,c.relname name,c.relkind,pg_get_userbyid(c.relowner) owner,c.relacl::text acl,
      c.relrowsecurity rls,c.relforcerowsecurity force_rls,
      (select e.extname from pg_depend d join pg_extension e on e.oid=d.refobjid
       where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype='e' limit 1) extension
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind in ('r','p','v','m','f') order by c.relname`,
    tablePrivileges: `select grantor,grantee,table_schema,table_name,privilege_type,is_grantable,with_hierarchy
      from information_schema.table_privileges where table_schema='public' order by table_name,grantee,privilege_type`,
    roleTableGrants: `select grantor,grantee,table_schema,table_name,privilege_type,is_grantable,with_hierarchy
      from information_schema.role_table_grants where table_schema='public' order by table_name,grantee,privilege_type`,
    exploded: `select c.relname name,pg_get_userbyid(c.relowner) owner,pg_get_userbyid(a.grantor) grantor,
      case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end grantee,a.privilege_type,a.is_grantable
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      where n.nspname='public' and c.relkind in ('r','p','v','m','f') order by name,grantee,privilege_type`,
    effective: `select c.relname name,r.rolname role,p.privilege,has_table_privilege(r.oid,c.oid,p.privilege) allowed
      from pg_class c join pg_namespace n on n.oid=c.relnamespace cross join pg_roles r
      cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p(privilege)
      where n.nspname='public' and c.relkind in ('r','p','v','m','f')
      and r.rolname in ('anon','authenticated','service_role') order by name,role,privilege`,
    defaults: `select pg_get_userbyid(d.defaclrole) owner,case when d.defaclnamespace=0 then '<global>' else n.nspname end schema,
      d.defaclobjtype kind,d.defaclacl::text acl,pg_get_userbyid(a.grantor) grantor,
      case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end grantee,a.privilege_type,a.is_grantable
      from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace
      cross join lateral aclexplode(d.defaclacl) a order by owner,schema,kind,grantee,privilege_type`,
    schemas: `select n.nspname name,pg_get_userbyid(n.nspowner) owner,n.nspacl::text acl,r.rolname role,
      has_schema_privilege(r.oid,n.oid,'CREATE') create_allowed,has_schema_privilege(r.oid,n.oid,'USAGE') usage_allowed
      from pg_namespace n cross join pg_roles r where n.nspname in ('public','auth','storage','extensions','realtime')
      and r.rolname in ('anon','authenticated','service_role') order by name,role`,
    roles: `select rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls from pg_roles order by rolname`,
    memberships: `select pg_get_userbyid(m.roleid) parent,pg_get_userbyid(m.member) member,
      pg_get_userbyid(m.grantor) grantor,m.admin_option,m.inherit_option,m.set_option from pg_auth_members m order by parent,member`,
    reachable: `select b.rolname subject,t.rolname target,pg_has_role(b.oid,t.oid,'USAGE') inherited,
      pg_has_role(b.oid,t.oid,'SET') settable from pg_roles b cross join pg_roles t
      where b.rolname in ('anon','authenticated') and (pg_has_role(b.oid,t.oid,'USAGE') or pg_has_role(b.oid,t.oid,'SET')) order by subject,target`,
    functions: `select p.oid::regprocedure::text signature,pg_get_userbyid(p.proowner) owner,p.prosecdef,p.proacl::text acl,
      p.proconfig,r.rolname role,has_function_privilege(r.oid,p.oid,'EXECUTE') allowed
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join pg_roles r
      where n.nspname='public' and p.prokind='f' and r.rolname in ('anon','authenticated','service_role')
      and not exists(select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')
      order by signature,role`,
  };
  /** @type {Record<string, Record<string, unknown>[]>} */
  const result = {};
  for (const [key, sql] of Object.entries(queries)) result[key] = (await db.query(sql)).rows;
  return result;
}
