-- VA coordinators are a distinct, non-staff account type. Authorization is
-- deliberately implemented separately from both staff and contractor roles.
alter type public.user_role add value if not exists 'va_coordinator';
