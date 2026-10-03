"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { LeadForm } from "@/components/crm/leads/lead-form";
import { updateLeadAction } from "@/app/(app)/actions";
import type { Lead, Profile } from "@/lib/types/domain";
import type { LeadFormInput } from "@/lib/validation/lead";

export function EditLeadDialog({
  lead,
  members,
  trigger,
  hasInstagram = false,
}: {
  lead: Lead;
  members: Profile[];
  trigger: React.ReactElement;
  hasInstagram?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  async function handleSubmit(input: LeadFormInput) {
    const result = await updateLeadAction(lead.id, input);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success("Lead updated");
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit lead</DialogTitle>
        </DialogHeader>
        <LeadForm
          members={members}
          defaultValues={{
            first_name: lead.first_name,
            last_name: lead.last_name ?? "",
            phone: lead.phone ?? "",
            email: lead.email ?? "",
            source: lead.source as LeadFormInput["source"],
            assigned_to: lead.assigned_to ?? "",
          }}
          onSubmit={handleSubmit}
          submitLabel="Save changes"
          showAssignment={false}
          channelOptional={hasInstagram}
        />
      </DialogContent>
    </Dialog>
  );
}
