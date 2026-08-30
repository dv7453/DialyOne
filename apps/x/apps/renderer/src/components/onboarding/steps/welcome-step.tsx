import { Loader2 } from "lucide-react"
import { motion } from "motion/react"
import { Button } from "@/components/ui/button"
import type { OnboardingState } from "../use-onboarding-state"

interface WelcomeStepProps {
  state: OnboardingState
}

export function WelcomeStep({ state }: WelcomeStepProps) {
  return (
    <div className="flex flex-col items-center justify-center text-center flex-1">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="flex items-center gap-4 mb-4"
      >
        <h1 className="text-3xl font-bold tracking-tight">
          Welcome to Dialy
        </h1>
        <div className="relative shrink-0">
          <div className="absolute inset-0 size-12 rounded-2xl bg-primary/10 blur-xl scale-[2.5]" />
          <img src="/dialy-mark.svg" alt="Dialy" className="relative size-12 rounded-2xl" />
        </div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
        className="inline-flex items-center gap-2 rounded-full border bg-muted/50 px-3.5 py-1.5 text-xs font-medium text-muted-foreground mb-10"
      >
        <span className="size-1.5 rounded-full bg-green-500 animate-pulse" />
        Your personal AI operator
      </motion.div>
      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.3 }}
        className="text-base text-muted-foreground leading-relaxed max-w-sm mb-10"
      >
        Dialy stays on while you are away — connects your apps, wakes only when needed, and works from your phone. Private and on your machine.
      </motion.p>

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.4 }}
        className="w-full max-w-xs"
      >
        <Button
          onClick={() => {
            state.setOnboardingPath("byok")
            state.setCurrentStep(1)
          }}
          size="lg"
          className="w-full h-12 text-base font-medium"
        >
          Get started
        </Button>
      </motion.div>
    </div>
  )
}
