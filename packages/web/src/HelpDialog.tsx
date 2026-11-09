import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./components/ui/dialog.tsx";

const rows = [
  ["工作台", "g h"],
  ["待处理", "g b"],
  ["需求", "g s"],
  ["度量", "g m"],
  ["全局搜索", "⌘K / Ctrl+K"],
  ["快捷键帮助", "?"],
  ["关闭面板", "Esc"],
] as const;

export function HelpDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogTitle>快捷键</DialogTitle>
        <DialogDescription className="sr-only">
          输入框或对话框打开时这些键不会跳转。
        </DialogDescription>
        <dl className="divide-y">
          {rows.map(([label, key]) => (
            <div
              key={label}
              className="flex items-center justify-between py-3 text-sm"
            >
              <dt>{label}</dt>
              <dd>
                <kbd className="rounded-sm border bg-surface px-2 py-1 font-mono text-xs">
                  {key}
                </kbd>
              </dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
