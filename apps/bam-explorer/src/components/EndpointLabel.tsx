export function EndpointLabel({ endpoint }: { endpoint: string }) {
  return (
    <span className="font-mono text-[11px] text-slate-500 tracking-tight">
      {endpoint}
    </span>
  );
}
