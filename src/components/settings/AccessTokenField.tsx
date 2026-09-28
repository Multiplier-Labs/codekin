/**
 * The local Codekin access token (machine connection). Verified on demand;
 * the dialog's Save commits it, so the value lives with the caller.
 */

import { input } from './Block'

interface Props {
  value: string
  onChange: (value: string) => void
  verifying: boolean
  status: 'idle' | 'valid' | 'invalid'
  onVerify: () => void
}

export function AccessTokenField({ value, onChange, verifying, status, onVerify }: Props) {
  return (
    <>
      <div className="flex gap-2">
        <input
          type="password"
          aria-label="Codekin access token"
          value={value}
          onChange={e => { onChange(e.target.value) }}
          placeholder="Enter your auth token"
          className={`${input} min-w-0 flex-1 font-mono`}
          onKeyDown={e => { if (e.key === 'Enter') onVerify() }}
        />
        <button
          onClick={onVerify}
          disabled={verifying || !value.trim()}
          className="rounded-control bg-primary-8 px-4 py-1.5 text-body font-medium text-on-primary hover:bg-primary-7 disabled:opacity-50"
        >
          {verifying ? '...' : 'Verify'}
        </button>
      </div>
      {status === 'valid' && (
        <p className="mt-2 text-meta text-success-6">Token verified successfully</p>
      )}
      {status === 'invalid' && (
        <p className="mt-2 text-meta text-error-5">Invalid token</p>
      )}
    </>
  )
}
