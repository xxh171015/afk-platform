import { useState } from "react";
import { Loader2, RotateCcw, ShieldCheck } from "lucide-react";
import type { Ticket } from "@/api/types";
import { useApproveProtected, useCancelTicket, useRetryTicket } from "@/api/queries";
import { blockedReasonGuide } from "@/lib/blocked-reasons";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from "@/components/ui/alert-dialog";

export function BlockedTicketActions({ ticket, onSuccess }: { ticket: Ticket; onSuccess?: (() => void) | undefined }) {
  const retry = useRetryTicket(); const approve = useApproveProtected(); const cancel = useCancelTicket();
  const [open, setOpen] = useState(false); const [cascade, setCascade] = useState(false);
  const [confirmRisk, setConfirmRisk] = useState<"approve" | "restart" | null>(null);
  const busy = retry.isPending || approve.isPending || cancel.isPending;
  const error = retry.error ?? approve.error ?? cancel.error;
  const success = () => onSuccess?.();
  return <div className="flex flex-wrap items-center gap-2">{ticket.blockedReason === "protected-path-changed" && <Button size="sm" disabled={busy} onClick={() => setConfirmRisk("approve")}>{approve.isPending ? <Loader2 className="animate-spin" /> : <ShieldCheck />}批准这些保护路径</Button>}
    {ticket.blockedReason && blockedReasonGuide[ticket.blockedReason].retryable ? <><Button size="sm" disabled={busy} onClick={() => retry.mutate({ id: ticket.id, mode: "continue" }, { onSuccess: success })}>{retry.isPending && retry.variables?.mode === "continue" && <Loader2 className="animate-spin" />}重试，保留已有工作</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirmRisk("restart")}>{retry.isPending && retry.variables?.mode === "restart" ? <Loader2 className="animate-spin" /> : <RotateCcw />}从头重试</Button></> : <p className="w-full text-xs text-muted-foreground">它等的票已取消，重试只会永远等下去。取消这张，或导入替代票</p>}
    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setOpen(true)}>取消…</Button>{error && <span role="alert" className="text-xs text-destructive">{error.message}</span>}
    <AlertDialog open={confirmRisk !== null} onOpenChange={v => { if (!v && !busy) setConfirmRisk(null); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{confirmRisk === "approve" ? `批准 ${ticket.displayId} 的保护路径？` : `从头重试 ${ticket.displayId}？`}</AlertDialogTitle><AlertDialogDescription>{confirmRisk === "approve" ? "这些受保护路径的改动将被人工放行，平台会继续合入集成分支；批准记录会保留在验收包中。" : "本次重试不会保留已有工作，将重新开始实现。"}</AlertDialogDescription></AlertDialogHeader>{confirmRisk === "approve" && <ul className="space-y-2 font-mono text-xs">{ticket.protectedPaths.map(path => <li className="break-all" key={path}>{path}</li>)}</ul>}{error && <p role="alert" className="text-xs text-destructive">{error.message}</p>}<AlertDialogFooter><AlertDialogCancel disabled={busy}>返回检查</AlertDialogCancel><Button disabled={busy} onClick={() => { const onSuccess = () => { setConfirmRisk(null); success(); }; if (confirmRisk === "approve") approve.mutate(ticket.id, { onSuccess }); else retry.mutate({ id: ticket.id, mode: "restart" }, { onSuccess }); }}>{busy && <Loader2 className="animate-spin" />}{confirmRisk === "approve" ? "确认批准并继续" : "确认从头重试"}</Button></AlertDialogFooter></AlertDialogContent></AlertDialog>
    <AlertDialog open={open} onOpenChange={v => { if (!busy) setOpen(v); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>取消 {ticket.displayId}？</AlertDialogTitle><AlertDialogDescription>取消不可撤销。依赖它的下游票会以 upstream-cancelled 停下，除非一并取消。</AlertDialogDescription></AlertDialogHeader><label className="flex items-center gap-2 text-sm"><Checkbox checked={cascade} onCheckedChange={v => setCascade(v === true)} />同时取消所有下游票</label><AlertDialogFooter>{cancel.error && <span role="alert" className="text-xs text-destructive">{cancel.error.message}</span>}<AlertDialogCancel disabled={busy}>返回</AlertDialogCancel><Button variant="destructive" disabled={busy} onClick={() => cancel.mutate({ id: ticket.id, cascade }, { onSuccess: () => { setOpen(false); success(); } })}>{cancel.isPending && <Loader2 className="animate-spin" />}永久取消 {ticket.displayId}</Button></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </div>;
}