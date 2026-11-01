import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog.tsx";

// The ? overlay: which chords go where, and that they do not fire while typing.

export function HelpDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>快捷键</DialogTitle>
          <DialogDescription>
            输入框或对话框打开时这些键不会跳转。
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[6rem_1fr] gap-2 text-sm">
          <dt>
            <kbd>g</kbd> <kbd>h</kbd>
          </dt>
          <dd>工作台</dd>
          <dt>
            <kbd>g</kbd> <kbd>s</kbd>
          </dt>
          <dd>需求</dd>
          <dt>
            <kbd>g</kbd> <kbd>b</kbd>
          </dt>
          <dd>待处理</dd>
          <dt>
            <kbd>⌘</kbd>
            <kbd>K</kbd>
          </dt>
          <dd>搜索</dd>
          <dt>
            <kbd>?</kbd>
          </dt>
          <dd>本说明</dd>
        </dl>
      </DialogContent>
    </Dialog>
  );
}
