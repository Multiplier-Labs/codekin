import type { Repo, Skill } from '../types'

interface Props {
  repo: Repo | null
  globalSkills?: Skill[]
  onSendSkill: (command: string) => void
}

export function SkillBrowser({ repo, globalSkills = [], onSendSkill }: Props) {
  const repoSkills = repo?.skills ?? []
  if (globalSkills.length === 0 && repoSkills.length === 0) return null

  return (
    <div className="mt-3 border-t border-neutral-10 pt-3">
      <h3 className="mb-2 text-[15px] font-medium uppercase tracking-wider text-neutral-5">Claude Skills</h3>

      {globalSkills.length > 0 && (
        <>
          <div className="mb-1 px-2 text-[12px] font-medium uppercase tracking-wider text-neutral-5">Global</div>
          <div className="flex flex-col gap-1">
            {globalSkills.map(skill => (
              <button
                key={skill.id}
                onClick={() => onSendSkill(skill.command)}
                className="group rounded px-2 py-1.5 text-left transition hover:bg-neutral-10/50"
              >
                <div className="text-[15px] font-medium text-accent-6 group-hover:text-accent-5">
                  {skill.command}
                </div>
                {skill.description && (
                  <div className="text-[13px] text-neutral-5 group-hover:text-neutral-4">
                    {skill.description}
                  </div>
                )}
              </button>
            ))}
          </div>
        </>
      )}

      {repoSkills.length > 0 && (
        <>
          <div className="mb-1 mt-2 px-2 text-[12px] font-medium uppercase tracking-wider text-neutral-5">{repo?.name}</div>
          <div className="flex flex-col gap-1">
            {repoSkills.map(skill => (
              <button
                key={skill.id}
                onClick={() => onSendSkill(skill.command)}
                className="group rounded px-2 py-1.5 text-left transition hover:bg-neutral-10/50"
              >
                <div className="text-[15px] font-medium text-accent-6 group-hover:text-accent-5">
                  {skill.command}
                </div>
                {skill.description && (
                  <div className="text-[13px] text-neutral-5 group-hover:text-neutral-4">
                    {skill.description}
                  </div>
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
