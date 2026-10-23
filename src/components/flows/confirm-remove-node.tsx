"use client";

/**
 * Confirmation before removing a node from the flow, shared by the list
 * view and the canvas side panel. Removing a node also clears every
 * arrow that pointed at it, so it deserves a second look; nothing is
 * stored until the person presses Save, and the copy says so.
 */

import { Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function ConfirmRemoveNode({
  nodeKey,
  open,
  onOpenChange,
  onConfirm,
}: {
  nodeKey: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const t = useTranslations("Flows.builder");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("removeNodeTitle")}</DialogTitle>
          <DialogDescription>{t("removeNodeBody", { key: nodeKey })}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            <Trash2 className="h-4 w-4" aria-hidden />
            {t("removeNode")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
