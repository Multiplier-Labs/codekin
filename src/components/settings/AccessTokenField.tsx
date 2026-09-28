/**
 * The local Codekin access token (machine connection). Verified on demand;
 * the dialog's Save commits it, so the value lives with the caller.
 */

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
      <label className="mb-1 block text-body text-ink-muted">Codekin access token</label>
      <div className="flex gap-2">
        <input
          type="password"
          value={value}
          onChange={e => { onChange(e.target.value) }}
          placeholder="Enter your auth token"
          className="flex-1 rounded-control border border-edge bg-surface px-3 py-2 text-body text-ink outline-none focus:border-primary-7"
          onKeyDown={e => { if (e.key === 'Enter') onVerify() }}
        />
        <button
          onClick={onVerify}
          disabled={verifying || !value.trim()}
          className="rounded-control bg-primary-8 px-3 py-2 text-body font-medium text-on-primary hover:bg-primary-7 disabled:opacity-50"
        >
          {verifying ? '...' : 'Verify'}
        </button>
      </div>
      {status === 'valid' && (
        <p className="mt-1 text-body text-success-6">Token verified successfully</p>
      )}
      {status === 'invalid' && (
        <p className="mt-1 text-body text-error-5">Invalid token</p>
      )}
    </>
  )
}
