import type { ReactNode } from "react";
import { useNavigation, useSubmit } from "react-router";

/**
 * The chrome every manual-trigger admin page shares: a sentence saying what
 * the button will do, and a button that POSTs once and disables itself while
 * the job runs. Rendering the page does nothing — see admin-trigger.server.ts.
 */
export function AdminTrigger({ heading, blurb, idleLabel, busyLabel, children }: {
  heading: string;
  blurb: ReactNode;
  idleLabel: string;
  busyLabel: string;
  children?: ReactNode;
}) {
  const running = useNavigation().state !== "idle";
  const submit = useSubmit();

  return (
    <s-page heading={heading}>
      <s-section>
        <s-stack gap="base">
          <s-paragraph>{blurb}</s-paragraph>
          <s-button
            variant="primary"
            disabled={running}
            onClick={() => submit(new FormData(), { method: "post" })}
          >
            {running ? busyLabel : idleLabel}
          </s-button>
          {children}
        </s-stack>
      </s-section>
    </s-page>
  );
}

/** The outcome, for the pages whose result is simply that the job ran. */
export function TriggerOutcome({ result, successHeading, errorHeading }: {
  result: { ok: boolean; startedAt: string; completedAt: string; errorMessage?: unknown } | undefined;
  successHeading: string;
  errorHeading: string;
}) {
  if (!result) return null;
  return (
    <>
      <s-banner tone={result.ok ? "success" : "critical"} heading={result.ok ? successHeading : errorHeading}>
        <s-paragraph>
          {result.ok
            ? `Started: ${result.startedAt} · Completed: ${result.completedAt}`
            : ('errorMessage' in result ? String(result.errorMessage) : 'Unknown error')}
        </s-paragraph>
      </s-banner>
      <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12 }}>
        {JSON.stringify(result, null, 2)}
      </pre>
    </>
  );
}
