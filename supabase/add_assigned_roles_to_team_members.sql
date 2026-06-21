-- migration: add_assigned_roles_to_team_members.sql

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'team_members' AND column_name = 'assigned_roles') THEN
        ALTER TABLE public.team_members ADD COLUMN assigned_roles uuid[];
        COMMENT ON COLUMN public.team_members.assigned_roles IS 'Array of business_roles.id assigned to the team member.';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'team_members' AND column_name = 'work_centers') THEN
        ALTER TABLE public.team_members ADD COLUMN work_centers jsonb DEFAULT '[]'::jsonb;
        COMMENT ON COLUMN public.team_members.work_centers IS 'JSONB array of custom screen-level overrides for this specific team member.';
    END IF;
END $$;
