"use server";

import { requireRole, requireSession } from "@/lib/auth/session";
import { runAction, type ActionResult } from "@/lib/actions/run";
import { disconnectCalendar } from "@/lib/services/calendar-connections";
import { createAdminClient } from "@/lib/supabase/admin";

export async function disconnectGoogleCalendarAction(): Promise<ActionResult> {
  const session = await requireRole(["admin"]);
  return runAction(
    "disconnectGoogleCalendar",
    () => disconnectCalendar(createAdminClient(), session.orgId, session.user.id),
    ["/settings", "/settings/integrations", "/settings/integrations/google"]
  );
}

/** Any member may disconnect their own calendar. */
export async function disconnectMyCalendarAction(): Promise<ActionResult> {
  const session = await requireSession();
  return runAction(
    "disconnectMyCalendar",
    () => disconnectCalendar(createAdminClient(), session.orgId, session.user.id, { personal: true }),
    ["/settings"]
  );
}
