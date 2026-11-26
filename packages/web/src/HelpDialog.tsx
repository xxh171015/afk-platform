import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./components/ui/dialog.tsx";

const rows = [
  ["工作台", "g h"],
  ["待审", "g r"],
  ["待处理", "g b"],
  ["需求", "g s"],
  ["度量", "g m"],
  ["全局搜索", "⌘K / Ctrl+K"],
  ["快捷键帮助", "?"],
  ["关闭面板", "Esc"],
] as const;

const reviewRows = [
  ["下一个文件", "j"],
  ["上一个文件", "k"],
  ["下一个 hunk", "n"],
  ["上一个 hunk", "p"],
  ["切已看", "v"],
  ["过滤路径", "/"],
  ["写意见", "c"],
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
        <h2 className="mt-4 text-sm font-medium">审查页</h2>
        <dl className="divide-y">
          {reviewRows.map(([label, key]) => (
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
