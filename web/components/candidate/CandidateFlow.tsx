"use client";

import { useState } from "react";
import { Header } from "../Header";
import { VerificationFlow } from "../VerificationFlow";
import { CodeScreen } from "./CodeScreen";
import { InfoScreen } from "./InfoScreen";
import { CANDIDATE_STEP_LABELS } from "@/lib/data";
import { checkCode, completeSubmission, joinTest } from "@/lib/client";
import type { PublicTest } from "@/lib/types";

type Step = "code" | "info" | "flow";

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
      setStep("flow");
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
        headerSteps={CANDIDATE_STEP_LABELS}
        stepOffset={2}
        headerRight={<span className="chip chip-sm">{candidateName}</span>}
        onComplete={(result) => completeSubmission(submissionId, result)}
        onHome={() => window.location.assign("/test")}
      />
    );
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <Header stepIndex={step === "code" ? 0 : 1} steps={CANDIDATE_STEP_LABELS} />
      <main className="app-main">
        {step === "code" && <CodeScreen submitting={submitting} error={error} onSubmit={onCode} />}
        {step === "info" && test && <InfoScreen test={test} submitting={submitting} error={error} onSubmit={onInfo} />}
      </main>
    </div>
  );
}
