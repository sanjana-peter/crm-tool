import Link from "next/link";
import { notFound } from "next/navigation";
import { Mail, Phone, PhoneCall, Pencil, Sparkles, CalendarClock, Video, Tag, IndianRupee } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { requireSession } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { getLead, getLeadTimeline } from "@/lib/services/leads";
import { listLeadStatuses, listOrgMembers } from "@/lib/services/team";
import { getOrganization } from "@/lib/services/settings";
import { getLeadAttribution } from "@/lib/services/meta";
import { listTemplates } from "@/lib/services/whatsapp";
import { getConversationState, listMessagesForLead } from "@/lib/services/conversations";
import { whatsappMode } from "@/lib/composition/whatsapp";
import { calendarMode } from "@/lib/composition/calendar";
import { formatDateTime } from "@/lib/format";
import { addDays, dueBoundaries } from "@/lib/domain/due";
import { canAccessLead, permissions } from "@/lib/domain/permissions";
import { LogCallDialog } from "@/components/crm/leads/log-call-dialog";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/crm/layout/empty-state";
import { StatusBadge } from "@/components/crm/leads/status-badge";
import { AssignLeadDialog } from "@/components/crm/leads/assign-lead-dialog";
import { ChangeStatusDialog } from "@/components/crm/leads/change-status-dialog";
import { ScheduleMeetingDialog } from "@/components/crm/leads/schedule-meeting-dialog";
import { AddNoteDialog } from "@/components/crm/leads/add-note-dialog";
import { AddFollowupDialog } from "@/components/crm/followups/add-followup-dialog";
import { EditLeadDialog } from "@/components/crm/leads/edit-lead-dialog";
import { ActivityTimeline } from "@/components/crm/leads/activity-timeline";
import { NotesList } from "@/components/crm/leads/notes-list";
import { MeetingsList } from "@/components/crm/leads/meetings-list";
import { FollowupRow } from "@/components/crm/followups/followup-row";
import { LeadAttributionCard } from "@/components/crm/leads/lead-attribution-card";
import { SendWhatsAppDialog } from "@/components/crm/leads/send-whatsapp-dialog";
import { WhatsAppMessagesList } from "@/components/crm/leads/whatsapp-messages-list";
import { WhatsAppConsentControl } from "@/components/crm/leads/whatsapp-consent-control";
import { SimulateReplyDialog } from "@/components/crm/leads/simulate-reply-dialog";
import type { Lead, LeadStatus, MetaLeadAttribution, Profile } from "@/lib/types/domain";

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireSession();
  const supabase = await createClient();

  const lead = await getLead(supabase, id);
  if (!lead) notFound();
  if (!canAccessLead(session.role, session.user.id, lead)) notFound();

  const [
    { notes, meetings, followups, activities },
    statuses,
    members,
    organization,
    attribution,
    waMode,
    calMode,
    whatsAppTemplates,
    whatsAppMessages,
    waState,
  ] = await Promise.all([
    getLeadTimeline(supabase, id),
    listLeadStatuses(supabase, session.orgId),
    listOrgMembers(supabase, session),
    getOrganization(supabase, session.orgId),
    getLeadAttribution(supabase, id),
    whatsappMode(supabase, session.orgId),
    calendarMode(supabase, session.orgId, session.user.id),
    listTemplates(supabase, session.orgId),
    listMessagesForLead(supabase, id),
    getConversationState(supabase, id),
  ]);

  const memberProfiles = members
    .map((m) => (Array.isArray(m.profile) ? m.profile[0] : m.profile) as Profile)
    .filter(Boolean);

  const leadTyped = lead as unknown as Lead & { status: LeadStatus; assignee: Profile | null };
  const nextFollowup = followups.find((f) => f.status === "pending") ?? null;
  const upcomingMeeting = meetings.find((m) => m.status === "scheduled") ?? null;

  const timezone = session.timezone;
  const tomorrow = addDays(dueBoundaries(new Date(), timezone).today, 1);
  const leadName = `${leadTyped.first_name} ${leadTyped.last_name ?? ""}`.trim();
  const canReassign = permissions.canViewAllLeads(session.role);
  // A salesperson can't hand leads around, but may take one nobody owns yet.
  const canClaim = !canReassign && leadTyped.assigned_to === null;
  const self = memberProfiles.filter((m) => m.id === session.user.id);
  const priority = (lead as { priority?: string }).priority;
  const value = (lead as { value?: number | null }).value;
  const lostReason = (lead as { lost_reason?: string | null }).lost_reason;
  const assigneeName = leadTyped.assignee?.full_name || leadTyped.assignee?.email || "Unassigned";
  const lastActivityAt = activities[0]?.created_at ?? null;

  return (
    <div className="-mx-4 -mt-4 md:-mx-6 md:-mt-6">
      {/* Identity strip — who this is, at a glance. Not sticky: it's read once, not needed while working the timeline below. */}
      <div className="bg-brand-wash border-b bg-card px-4 py-5 md:px-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">
                {leadTyped.first_name} {leadTyped.last_name}
              </h1>
              <EditLeadDialog
                lead={leadTyped}
                members={memberProfiles}
                trigger={
                  <Button variant="ghost" size="icon-sm" aria-label="Edit lead">
                    <Pencil className="size-3.5" />
                  </Button>
                }
              />
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
              {leadTyped.phone && (
                <span className="flex items-center gap-1.5">
                  <Phone className="size-3.5" /> {leadTyped.phone}
                </span>
              )}
              {leadTyped.email && (
                <span className="flex items-center gap-1.5">
                  <Mail className="size-3.5" /> {leadTyped.email}
                </span>
              )}
              <span className="flex items-center gap-1.5">
                <Tag className="size-3.5" /> {leadTyped.source}
              </span>
              {value != null && (
                <span className="flex items-center gap-1.5">
                  <IndianRupee className="size-3.5" />
                  {new Intl.NumberFormat("en-IN", { style: "currency", currency: (organization.currency as string) ?? "INR", maximumFractionDigits: 0 }).format(value)}
                </span>
              )}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              {priority && priority !== "medium" && (
                <Badge variant="outline" className={priority === "high" ? "border-amber-600/40 text-amber-700 dark:text-amber-400" : ""}>
                  {priority} priority
                </Badge>
              )}
              {lostReason && <span className="text-red-700 dark:text-red-400">Lost: {lostReason}</span>}
            </div>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <StatusBadge status={leadTyped.status} />
            <span className="text-sm text-muted-foreground">Assigned to {assigneeName}</span>
            {lastActivityAt && (
              <span className="text-xs text-muted-foreground">Last activity {formatDateTime(lastActivityAt, timezone)}</span>
            )}
          </div>
        </div>
      </div>

      {/* Sticky command bar — the actions a salesperson reaches for constantly, always in reach while scrolling the timeline. */}
      <div className="sticky top-0 z-10 border-b bg-background/95 px-4 py-2.5 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:px-6">
        <div className="flex flex-wrap gap-2">
          {leadTyped.phone && (
            <a href={`tel:${leadTyped.phone}`} className={buttonVariants()}>
              <PhoneCall /> Call
            </a>
          )}
          <LogCallDialog
            leadId={id}
            leadName={leadName}
            defaultFollowupDate={tomorrow}
            trigger={<Button variant={leadTyped.phone ? "outline" : "default"}>Log call</Button>}
          />
          {waMode !== "unavailable" && leadTyped.phone && (
            <SendWhatsAppDialog
              leadId={id}
              leadFirstName={leadTyped.first_name}
              templates={whatsAppTemplates}
              windowOpen={waState.windowOpen}
              optedOut={waState.consent === "opted_out"}
              demo={waMode === "demo"}
              trigger={<Button variant="outline">Send WhatsApp</Button>}
            />
          )}
          <ScheduleMeetingDialog
            leadId={id}
            calendarMode={calMode}
            defaultDate={dueBoundaries(new Date(), timezone).today}
            contactEmail={(lead.contact as { email_normalized?: string | null } | null)?.email_normalized ?? null}
            timezone={timezone}
            calendlyBookingUrl={organization.calendly_booking_url}
            trigger={<Button variant="outline">Schedule Meeting</Button>}
          />
          <AddFollowupDialog
            leadId={id}
            members={memberProfiles}
            defaultAssignee={leadTyped.assigned_to ?? session.user.id}
            trigger={<Button variant="outline">Add Follow-up</Button>}
          />
          <AddNoteDialog leadId={id} trigger={<Button variant="outline">Add Note</Button>} />
          <ChangeStatusDialog
            leadId={id}
            statuses={statuses}
            currentStatusId={leadTyped.status_id}
            trigger={<Button variant="outline">Change Stage</Button>}
          />
          <div className="ms-auto flex gap-2">
            {canReassign && (
              <AssignLeadDialog
                leadId={id}
                members={memberProfiles}
                currentAssignee={leadTyped.assigned_to}
                trigger={<Button variant="ghost">{leadTyped.assigned_to ? "Reassign" : "Assign"}</Button>}
              />
            )}
            {canClaim && (
              <AssignLeadDialog
                leadId={id}
                members={self}
                currentAssignee={leadTyped.assigned_to}
                trigger={<Button variant="ghost">Claim lead</Button>}
              />
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 p-4 lg:grid-cols-3 md:p-6">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Activity Timeline</CardTitle>
            </CardHeader>
            <CardContent>
              <ActivityTimeline activities={activities} timezone={timezone} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Notes</CardTitle>
            </CardHeader>
            <CardContent>
              <NotesList notes={notes} timezone={timezone} />
            </CardContent>
          </Card>

          {waMode !== "unavailable" && (
            <Card>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
                  <span className="flex items-center gap-2">
                    WhatsApp
                    {waMode === "demo" && <Badge variant="outline">Demo mode</Badge>}
                  </span>
                  {waMode === "demo" && <SimulateReplyDialog leadId={id} leadName={leadName} />}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <WhatsAppConsentControl
                  leadId={id}
                  status={waState.consent}
                  source={(lead.contact as { whatsapp_consent_source?: string | null } | null)?.whatsapp_consent_source ?? null}
                />
                <WhatsAppMessagesList messages={whatsAppMessages} timezone={timezone} />
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          {attribution && (
            <LeadAttributionCard attribution={attribution as unknown as MetaLeadAttribution} timezone={timezone} />
          )}

          {/* Snapshot: the two "what's next" facts a manager scans for first, combined into one glance instead of two separate cards. */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Snapshot</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">Next follow-up</p>
                {nextFollowup ? (
                  <FollowupRow followup={nextFollowup} timezone={timezone} />
                ) : (
                  <p className="text-sm text-muted-foreground">No follow-up scheduled.</p>
                )}
              </div>
              <div className="border-t pt-4">
                <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <CalendarClock className="size-3.5" /> Upcoming meeting
                </p>
                {upcomingMeeting ? (
                  <p className="text-sm">
                    {formatDateTime(upcomingMeeting.scheduled_start, timezone)}
                    {upcomingMeeting.meeting_url && (
                      <>
                        <br />
                        <Link
                          href={upcomingMeeting.meeting_url}
                          target="_blank"
                          className="inline-flex items-center gap-1 text-primary hover:underline"
                        >
                          <Video className="size-3.5" /> Join meeting
                        </Link>
                      </>
                    )}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">No upcoming meeting.</p>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Honest placeholder: no AI capability exists yet, so this says so instead of pretending. */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">AI Insights</CardTitle>
            </CardHeader>
            <CardContent>
              <EmptyState
                icon={Sparkles}
                tone="muted"
                title="Not available yet"
                description="This space is reserved for an automatic summary and next-action suggestion once that's built — a person, not AI, decides what happens next for now."
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Meetings</CardTitle>
            </CardHeader>
            <CardContent>
              <MeetingsList meetings={meetings} timezone={timezone} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Follow-up History</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {followups.length === 0 ? (
                <p className="text-sm text-muted-foreground">No follow-ups yet.</p>
              ) : (
                followups.map((f) => <FollowupRow key={f.id} followup={f} timezone={timezone} />)
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
