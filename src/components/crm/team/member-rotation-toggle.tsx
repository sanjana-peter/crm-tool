"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { setMemberInRotationAction } from "@/app/(app)/team/actions";

/** Admin-only checkbox: whether round-robin hands this person new leads. */
export function MemberRotationToggle({ userId, inRotation, name }: { userId: string; inRotation: boolean; name: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [checked, setChecked] = useState(inRotation);

  function toggle(next: boolean) {
    setChecked(next);
    startTransition(async () => {
      const result = await setMemberInRotationAction(userId, next);
      if (!result.ok) {
        toast.error(result.error);
        setChecked(!next);
        return;
      }
      toast.success(next ? `${name} is in the lead rotation` : `${name} is out of the lead rotation`);
      router.refresh();
    });
  }

  return (
    <input
      type="checkbox"
      className="size-4"
      checked={checked}
      disabled={pending}
      onChange={(e) => toggle(e.target.checked)}
      aria-label={`${name} is in the lead rotation`}
    />
  );
}
