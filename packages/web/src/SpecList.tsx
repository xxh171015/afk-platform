import { useQuery } from "@tanstack/react-query";
import { describeError, useApi } from "./api.tsx";

// The front page: every spec, its state, and how far its tickets have got.

export function SpecList() {
  const api = useApi();
  const specs = useQuery({
    queryKey: ["specs"],
    queryFn: async () => {
      const { data, error } = await api.GET("/specs");
      if (!data) throw new Error(describeError(error));
      return data.specs;
    },
    refetchInterval: 5_000,
  });

  if (specs.isPending) return <p className="note">Loading specs…</p>;
  if (specs.isError)
    return (
      <p className="error" role="alert">
        Could not load the specs: {specs.error.message}
      </p>
    );
  if (specs.data.length === 0)
    return (
      <p className="note">
        No specs yet. Create one with <code>plat spec create</code>.
      </p>
    );

  return (
    <table className="specs">
      <thead>
        <tr>
          <th>Spec</th>
          <th>Title</th>
          <th>Project</th>
          <th>State</th>
          <th>Progress</th>
        </tr>
      </thead>
      <tbody>
        {specs.data.map((spec) => {
          const { progress } = spec;
          const percent =
            progress.total === 0
              ? 0
              : Math.round((progress.done / progress.total) * 100);
          return (
            <tr key={spec.id}>
              <td>
                <a href={`#/specs/${spec.id}`}>{spec.displayId}</a>
              </td>
              <td>{spec.title}</td>
              <td>{spec.project}</td>
              <td>
                <span className={`badge spec-${spec.state}`}>{spec.state}</span>
              </td>
              <td>
                <div
                  className="progress"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={progress.total}
                  aria-valuenow={progress.done}
                  aria-label={`${spec.displayId} progress`}
                >
                  <div
                    className="progress-done"
                    style={{ width: `${percent}%` }}
                  />
                </div>
                <span className="progress-text">
                  {progress.done}/{progress.total} done
                  {progress.blocked > 0 ? `, ${progress.blocked} blocked` : ""}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
