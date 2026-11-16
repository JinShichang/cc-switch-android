import { useEffect, useState } from "react";
export function DataStatus({ usage = false }: { usage?: boolean }) {
  const [warning, setWarning] = useState("");
  useEffect(() => {
    const listener = (e: Event) =>
      setWarning(String((e as CustomEvent).detail ?? ""));
    window.addEventListener("android-data-warning", listener);
    return () => window.removeEventListener("android-data-warning", listener);
  }, []);
  return (
    <>
      {usage && (
        <p className="px-2 text-caption text-fg-2">
          来源：授权目录中的 Codex 会话日志。HTTP
          状态和精确耗时未知；费用按配置价格估算，未定价显示“未定价”。
        </p>
      )}
      {warning && (
        <p role="status" className="px-2 text-caption text-warning-text">
          {warning}
        </p>
      )}
    </>
  );
}
