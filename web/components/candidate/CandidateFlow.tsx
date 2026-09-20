"use client";

import { useState } from "react";
import { Header } from "../Header";
import { VerificationFlow } from "../VerificationFlow";
import { CodeScreen } from "./CodeScreen";
import { InfoScreen } from "./InfoScreen";
import { RoleConfirmScreen } from "./RoleConfirmScreen";
import { CANDIDATE_STEP_LABELS } from "@/lib/data";
import { checkCode, completeSubmission, joinTest } from "@/lib/client";
import type { PublicTest } from "@/lib/types";

type Step = "code" | "info" | "confirm" | "flow";
const STEP_INDEX: Record<Step, number> = { code: 0, info: 1, confirm: 2, flow: 3 };

export function CandidateFlow({ fast = false }: { fast?: boolean }) {
  const [step, setStep] = useState<Step>("code");
  const [code, setCode] = useState("");
  const [test, setTest] = useState<PublicTest | null>(null);
  const [submissionId, setSubmissionId] = useState<string | null>(null);
  const [candidateName, setCandidateName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onCode = async (value: string) => {
    setSubmitting(true);
    setError(null);
    try {
      setTest(await checkCode(value));
      setCode(value);
      setStep("info");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const onInfo = async (info: { name: string; birthDate: string; phone: string }) => {
    setSubmitting(true);
    setError(null);
    try {
      const joined = await joinTest({ code, ...info });
      setTest(joined.test);
      setSubmissionId(joined.submissionId);
      setCandidateName(info.name.trim());
      setStep("confirm");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  if (step === "flow" && test && submissionId) {
    return (
      <VerificationFlow
        demo={test.mode === "demo"}
        fastAnalysis={fast}
        totalSeconds={test.totalSeconds}
        questionCount={test.questionCount}
        initialRole={test.role}
        headerSteps={CANDIDATE_STEP_LABELS}
        stepOffset={3}
        headerRight={<span className="chip chip-sm">{candidateName}</span>}
        onComplete={(result) => completeSubmission(submissionId, result)}
        onHome={() => window.location.assign("/test")}
      />
    );
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <Header stepIndex={STEP_INDEX[step]} steps={CANDIDATE_STEP_LABELS} right={candidateName ? <span className="chip chip-sm">{candidateName}</span> : null} />
      <main className="app-main">
        {step === "code" && <CodeScreen submitting={submitting} error={error} onSubmit={onCode} />}
        {step === "info" && test && <InfoScreen test={test} submitting={submitting} error={error} onSubmit={onInfo} />}
        {step === "confirm" && test && <RoleConfirmScreen role={test.role} roleLabel={test.roleLabel} testTitle={test.title} onConfirm={() => setStep("flow")} />}
      </main>
    </div>
  );
}
