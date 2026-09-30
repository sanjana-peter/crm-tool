import { requireSession } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { listOrgMembers } from "@/lib/services/team";
import { getAssignmentMode } from "@/lib/services/assignment";
import { permissions } from "@/lib/domain/permissions";
import { Badge } from "@/components/ui/badge";
import { PersonAvatar } from "@/components/crm/layout/person-avatar";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { InviteMemberDialog } from "@/components/crm/team/invite-member-dialog";
import { MemberRoleSelect } from "@/components/crm/team/member-role-select";
import { MemberActiveToggle } from "@/components/crm/team/member-active-toggle";
import { MemberRotationToggle } from "@/components/crm/team/member-rotation-toggle";
import { AssignmentModeCard } from "@/components/crm/team/assignment-mode-card";
import type { Profile, OrgRole } from "@/lib/types/domain";

const ROLE_VARIANT: Record<OrgRole, string> = {
  admin: "border-purple-600/30 bg-purple-50 text-purple-700 dark:bg-purple-950 dark:text-purple-400",
  manager: "border-blue-600/30 bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-400",
  salesperson: "border-muted-foreground/30 bg-muted text-muted-foreground",
};

export default async function TeamPage() {
  const session = await requireSession();
  const supabase = await createClient();
  const canManage = permissions.canManageTeam(session.role);
  const [members, assignmentMode] = await Promise.all([
    listOrgMembers(supabase, session),
    canManage ? getAssignmentMode(supabase, session.orgId) : Promise.resolve(null),
  ]);
  const rotationSize = members.filter((m) => m.in_rotation && m.is_active !== false).length;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Team</h1>
          <p className="text-sm text-muted-foreground">Everyone with access to {session.orgName}.</p>
        </div>
        {canManage && <InviteMemberDialog />}
      </div>

      {canManage && assignmentMode && <AssignmentModeCard mode={assignmentMode} rotationSize={rotationSize} />}

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              {canManage && <TableHead>In rotation</TableHead>}
              {canManage && <TableHead className="text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((m) => {
              const profile = (Array.isArray(m.profile) ? m.profile[0] : m.profile) as Profile;
              const isActive = m.is_active !== false;
              return (
                <TableRow key={m.id}>
                  <TableCell className="flex items-center gap-2 font-medium">
                    <PersonAvatar name={profile.full_name || profile.email} className="size-7" />
                    {profile.full_name || "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{profile.email}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={ROLE_VARIANT[m.role as OrgRole]}>
                      {m.role}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {isActive ? (
                      <Badge variant="secondary">Active</Badge>
                    ) : (
                      <Badge variant="destructive">Deactivated</Badge>
                    )}
                  </TableCell>
                  {canManage && (
                    <TableCell>
                      <MemberRotationToggle
                        userId={m.user_id as string}
                        inRotation={Boolean(m.in_rotation)}
                        name={profile.full_name || profile.email}
                      />
                    </TableCell>
                  )}
                  {canManage && (
                    <TableCell className="flex items-center justify-end gap-2 text-right">
                      <MemberRoleSelect
                        userId={m.user_id as string}
                        role={m.role as OrgRole}
                        name={profile.full_name || profile.email}
                      />
                      <MemberActiveToggle
                        userId={m.user_id as string}
                        isActive={isActive}
                        isSelf={m.user_id === session.user.id}
                      />
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
