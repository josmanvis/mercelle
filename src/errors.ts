/**
 * Typed error classes so the CLI can render actionable messages instead of stack traces.
 */

export class MercelleError extends Error {
  /** Optional extra lines printed under the message (hints, remedies). */
  readonly hints: string[]

  constructor(message: string, hints: string[] = []) {
    super(message)
    this.name = 'MercelleError'
    this.hints = hints
  }
}

/** OrbStack is not installed or not running. */
export class OrbStackMissingError extends MercelleError {
  constructor(detail?: string) {
    super(
      'OrbStack was not found.',
      [
        'Install it from https://orbstack.dev/download and launch the app once.',
        'Then re-run this command.',
        ...(detail ? [`Details: ${detail}`] : []),
      ],
    )
    this.name = 'OrbStackMissingError'
  }
}

/** A project could not be detected or is missing required files. */
export class ProjectDetectionError extends MercelleError {
  constructor(message: string, hints: string[] = []) {
    super(message, hints)
    this.name = 'ProjectDetectionError'
  }
}

/** An `orb` command failed. */
export class OrbCommandError extends MercelleError {
  readonly command: string
  readonly result: { code: number; stdout: string; stderr: string }

  constructor(command: string, result: { code: number; stdout: string; stderr: string }) {
    super(`Command failed (exit ${result.code}): ${command}`, [
      result.stderr.trim() || result.stdout.trim() || 'No output was captured.',
    ])
    this.name = 'OrbCommandError'
    this.command = command
    this.result = result
  }
}
