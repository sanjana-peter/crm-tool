"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { setAssignmentModeAction } from "@/app/(app)/team/actions";
import type { AssignmentMode } from "@/lib/domain/assignment";

const LABELS: Record<AssignmentMode, string> = {
  manual: "Manual (unassigned pool)",
  round_robin: "Round-robin",
};

/** Admin-only: how leads that arrive without an assignee (Meta, file import) are routed. */
export function AssignmentModeCard({ mode, rotationSize }: { mode: AssignmentMode; rotationSize: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState<AssignmentMode>(mode);

  function change(next: AssignmentMode) {
    const previous = value;
    setValue(next);
    startTransition(async () => {
      const result = await setAssignmentModeAction(next);
      if (!result.ok) {
        toast.error(result.error);
        setValue(previous);
        return;
      }
      toast.success(next === "round_robin" ? "Round-robin assignment is on" : "Leads now go to the unassigned pool");
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Lead assignment</CardTitle>
        <CardDescription>
          For leads that arrive without an assignee — Meta lead ads and file imports. Leads you add by hand are assigned
          in the form, and a Meta default assignee always wins.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="max-w-xs space-y-1.5">
          <Label htmlFor="assignment-mode">New leads go to</Label>
          <Select value={value} onValueChange={(v) => v && v !== value && change(v as AssignmentMode)} disabled={pending}>
            <SelectTrigger id="assignment-mode">
              <SelectValue>{(v: AssignmentMode) => LABELS[v]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(LABELS) as AssignmentMode[]).map((m) => (
                <SelectItem key={m} value={m}>
                  {LABELS[m]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="text-sm text-muted-foreground">
          {value === "round_robin"
            ? rotationSize > 0
              ? `Each new lead goes to the next of the ${rotationSize} active ${rotationSize === 1 ? "person" : "people"} marked “In rotation” below, in turn.`
              : "Nobody is in the rotation yet, so leads still land in the unassigned pool. Mark people “In rotation” below."
            : "New leads wait in the unassigned pool, where any salesperson can claim them."}
        </p>
      </CardContent>
    </Card>
  );
}
