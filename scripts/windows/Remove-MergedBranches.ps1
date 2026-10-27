<#
.SYNOPSIS
    Remove local branches whose upstream was deleted after the pull request merged.

.DESCRIPTION
    Intended as the opening step of a working session, and especially useful in a
    clone that several people or agents share.

    When a pull request is squash-merged and its head branch is deleted on the
    remote, the local branch stays behind, and `git branch -d` refuses to remove
    it: a squashed commit has a different SHA than the branch it came from, so
    the branch never looks fully merged. This script therefore decides on
    upstream state rather than commit reachability. A branch counts as merged
    once it had an upstream and that upstream is gone, which is what happens when
    the remote deletes the head branch on merge.

    That also makes the sweep safe by construction. A branch that was never
    pushed has no upstream at all and can never be reported as gone, so
    local-only experiments are never swept. Branches checked out in another
    worktree are reported and skipped rather than left to fail, and the default
    branch is never removed.

    The working tree must be clean. A dirty tree usually means unfinished work,
    so the script stops rather than guessing what to do with it. A clean tree is
    not enough to leave a branch, though: someone may have committed and be
    waiting on CI. The script only moves off a branch whose upstream is gone.

    Run `git config --global fetch.prune true` once per machine so the gone
    markers appear without passing --prune on every fetch.

    A repository with no remote yet, as a freshly initialized project has, is
    fine: there is simply nothing to sweep. A fetch that fails because the remote
    is unreachable only warns, since the recorded upstream state stays accurate
    and an offline run can at worst miss a recently merged branch.

.PARAMETER ReturnToDefault
    Switch to the default branch and fast-forward it after sweeping. The switch
    happens regardless when the current branch is one of the deleted ones,
    because a checked-out branch cannot be removed. A current branch that has
    not merged - its upstream still exists, it was never pushed, or HEAD is
    detached - is left checked out with a warning, and the default branch is not
    fast-forwarded. A fast-forward that fails is reported as a warning and leaves
    the default branch where it was; a default branch with no upstream yet is
    left as it is.

.PARAMETER SkipFetch
    Skip `git fetch --prune`. Only useful when a fetch just ran, since without a
    prune the deleted upstreams are not yet visible as gone.

.PARAMETER RepositoryRoot
    Override the repository to operate on. Intended for isolated validation.

.EXAMPLE
    .\Remove-MergedBranches.ps1 -WhatIf
    Show which branches would be removed without changing anything.

.EXAMPLE
    .\Remove-MergedBranches.ps1 -ReturnToDefault
    Sweep merged branches, then land on an up-to-date default branch.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory = $false)]
    [switch]$ReturnToDefault,

    [Parameter(Mandatory = $false)]
    [switch]$SkipFetch,

    [Parameter(Mandatory = $false)]
    [string]$RepositoryRoot
)

$ErrorActionPreference = "Stop"

function Invoke-Git {
    param([string[]]$Arguments, [switch]$AllowFailure)

    # git reports ordinary progress such as "From <remote>" or "Switched to
    # branch" on stderr. Windows PowerShell 5.1 turns each of those lines into an
    # error record under 2>&1, which "Stop" throws on even when git succeeded, so
    # judge git by its exit code and keep its lines as text.
    $ErrorActionPreference = "Continue"
    $output = & git -C $script:RepoRoot @Arguments 2>&1 | ForEach-Object { "$_" }
    if ($LASTEXITCODE -ne 0 -and -not $AllowFailure) {
        throw "git $($Arguments -join ' ') failed with exit code $LASTEXITCODE`n$output"
    }
    return $output
}

function Update-DefaultBranch {
    param([string]$Name)

    Invoke-Git @("rev-parse", "--verify", "--quiet", "HEAD") -AllowFailure | Out-Null
    if ($LASTEXITCODE -ne 0) {
        # An unborn branch has no commit to fast-forward from yet.
        Write-Host "  stay   $Name (no commits yet)"
        return
    }

    $before = (Invoke-Git @("rev-parse", "--short", "HEAD") | Select-Object -First 1).ToString().Trim()
    Invoke-Git @("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}") -AllowFailure | Out-Null
    if ($LASTEXITCODE -ne 0) {
        # A freshly initialized project has nothing to fast-forward from yet.
        Write-Host "  stay   $Name (no upstream to fast-forward from, at $before)"
        return
    }

    $output = Invoke-Git @("pull", "--ff-only") -AllowFailure
    if ($LASTEXITCODE -ne 0) {
        # Offline, a local branch that diverged, or another process holding the
        # index lock. None of them damage anything, but reporting success would
        # leave a stale default branch looking current.
        Write-Warning "git pull --ff-only failed, so '$Name' stays at $before.`n$($output -join "`n")"
        return
    }

    $after = (Invoke-Git @("rev-parse", "--short", "HEAD") | Select-Object -First 1).ToString().Trim()
    if ($after -eq $before) {
        Write-Host "  pull   $Name (already up to date at $after)"
    } else {
        Write-Host "  pull   $Name (fast-forwarded $before..$after)"
    }
}

function Test-LocalBranch {
    param([string]$Name)

    if (-not $Name) { return $false }
    Invoke-Git @("show-ref", "--verify", "--quiet", "refs/heads/$Name") -AllowFailure | Out-Null
    return ($LASTEXITCODE -eq 0)
}

function Get-RemoteDefaultBranch {
    $ref = Invoke-Git @("symbolic-ref", "--quiet", "refs/remotes/origin/HEAD") -AllowFailure
    if ($LASTEXITCODE -eq 0 -and $ref) {
        return ($ref | Select-Object -First 1).ToString().Trim() -replace '^refs/remotes/origin/', ''
    }
    return $null
}

function Resolve-DefaultBranch {
    # origin/HEAD records what the remote considers default. Prefer it, and try
    # once to populate it when the clone never recorded one.
    $name = Get-RemoteDefaultBranch
    if ($name) { return $name }

    Invoke-Git @("remote", "set-head", "origin", "--auto") -AllowFailure | Out-Null
    $name = Get-RemoteDefaultBranch
    if ($name) { return $name }

    # No remote, or one that has never been reachable. Guessing a name here is
    # how a freshly initialized project breaks, because init.defaultBranch
    # varies by machine. Only return a branch that actually exists.
    $configured = Invoke-Git @("config", "--get", "init.defaultBranch") -AllowFailure
    $configuredName = if ($LASTEXITCODE -eq 0 -and $configured) {
        ($configured | Select-Object -First 1).ToString().Trim()
    } else {
        $null
    }

    foreach ($candidate in @($configuredName, "main", "master")) {
        if (Test-LocalBranch $candidate) { return $candidate }
    }

    return $null
}

# Resolve the repository first so every later call is explicitly scoped to it.
$startDir = if ($RepositoryRoot) { $RepositoryRoot } else { (Get-Location).Path }
$script:RepoRoot = & {
    # See Invoke-Git: outside a repository git's stderr would otherwise throw on
    # Windows PowerShell 5.1 before the clearer message below.
    $ErrorActionPreference = "Continue"
    & git -C $startDir rev-parse --show-toplevel 2>$null
}
if ($LASTEXITCODE -ne 0 -or -not $script:RepoRoot) {
    throw "Not a git repository: $startDir"
}
$script:RepoRoot = $script:RepoRoot.Trim()

# A dirty tree in a shared clone is somebody else's unfinished work.
$dirty = Invoke-Git @("status", "--porcelain")
if ($dirty) {
    $count = @($dirty).Count
    throw "Working tree is not clean ($count entries). Resolve or stash that work before sweeping branches."
}

# Stale worktree registrations keep their branches undeletable, so clear them
# before deciding what can go.
Invoke-Git @("worktree", "prune") | Out-Null

# A failed fetch is not fatal. `gone` is recorded by an earlier successful prune
# and stays accurate, so the worst an offline run can do is miss a branch that
# was merged since the last fetch - it can never delete the wrong one.
if (-not $SkipFetch) {
    Invoke-Git @("fetch", "--prune") -AllowFailure | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "git fetch --prune failed; sweeping on the upstream state already recorded. Branches merged since the last successful fetch will not be detected yet."
    }
}

$defaultBranch = Resolve-DefaultBranch

$currentBranch = (Invoke-Git @("branch", "--show-current") | Select-Object -First 1)
if ($currentBranch) { $currentBranch = $currentBranch.ToString().Trim() }

# Branches held by another worktree cannot be deleted; git blocks it for us, but
# reporting them is more useful than surfacing a raw error.
$worktreeBranches = @{}
foreach ($line in @(Invoke-Git @("worktree", "list", "--porcelain"))) {
    $text = $line.ToString()
    if ($text -match '^branch\s+refs/heads/(.+)$') {
        $name = $Matches[1]
        if ($name -ne $currentBranch) { $worktreeBranches[$name] = $true }
    }
}

$gone = @()
foreach ($line in @(Invoke-Git @("for-each-ref", "--format=%(refname:short)%09%(upstream:track,nobracket)", "refs/heads"))) {
    $parts = $line.ToString().Split("`t")
    if ($parts.Count -ge 2 -and $parts[1].Trim() -eq "gone") {
        $gone += $parts[0].Trim()
    }
}

# Only a gone upstream shows the current branch landed; a detached HEAD has none.
$currentMerged = [bool]($currentBranch -and ($gone -contains $currentBranch))

# The default branch tracks a live upstream and should never reach this list,
# but never delete the branch everything else falls back to.
$gone = @($gone | Where-Object { $_ -ne $defaultBranch })

$blocked = @($gone | Where-Object { $worktreeBranches.ContainsKey($_) })
$deletable = @($gone | Where-Object { -not $worktreeBranches.ContainsKey($_) })

foreach ($name in $blocked) {
    Write-Host "  skip   $name (checked out in another worktree)"
}

if ($deletable.Count -eq 0) {
    Write-Host "No merged branches to remove."
} else {
    # A checked-out branch cannot be deleted, so step off it first.
    if ($currentBranch -and $deletable -contains $currentBranch) {
        if (-not $defaultBranch) {
            Write-Host "  skip   $currentBranch (checked out, and no default branch to switch to)"
            $deletable = @($deletable | Where-Object { $_ -ne $currentBranch })
        } elseif ($PSCmdlet.ShouldProcess($defaultBranch, "Switch away from '$currentBranch' before deleting it")) {
            Invoke-Git @("switch", $defaultBranch) | Out-Null
            Write-Host "  switch $defaultBranch (left '$currentBranch' so it can be removed)"
            $currentBranch = $defaultBranch
        } elseif (-not $WhatIfPreference) {
            # Declined under -Confirm: the branch cannot be deleted while it is
            # still checked out, so drop it. -WhatIf also lands here because
            # ShouldProcess reports false, but there the intent is a preview, so
            # keep the branch listed and let the delete below be previewed too.
            $deletable = @($deletable | Where-Object { $_ -ne $currentBranch })
        }
    }

    foreach ($name in $deletable) {
        # -D, not -d: a squashed branch is never reachable from the default
        # branch, so -d refuses every time. `gone` is the merge evidence here.
        if ($PSCmdlet.ShouldProcess($name, "Delete merged local branch")) {
            $sha = (Invoke-Git @("rev-parse", "--short", $name) | Select-Object -First 1).ToString().Trim()
            Invoke-Git @("branch", "-D", $name) | Out-Null
            Write-Host "  delete $name (was $sha)"
        }
    }
}

if ($ReturnToDefault) {
    if (-not $defaultBranch) {
        Write-Warning "No default branch could be determined, so -ReturnToDefault did nothing."
    } elseif ($currentBranch -ne $defaultBranch -and -not $currentMerged) {
        # A clean tree only shows the work was committed. In a shared clone this
        # branch may be someone else's, still waiting on its pull request.
        $position = if ($currentBranch) {
            "'$currentBranch', which has not merged (its upstream still exists, or it was never pushed)"
        } else {
            "a detached HEAD"
        }
        Write-Warning "Staying on $position, so -ReturnToDefault did not switch to or fast-forward '$defaultBranch'. Switch yourself once nobody is working here."
    } elseif ($currentBranch -ne $defaultBranch) {
        if ($PSCmdlet.ShouldProcess($defaultBranch, "Switch and fast-forward")) {
            Invoke-Git @("switch", $defaultBranch) | Out-Null
            Write-Host "  switch $defaultBranch (left merged '$currentBranch')"
            Update-DefaultBranch $defaultBranch
        }
    } else {
        if ($PSCmdlet.ShouldProcess($defaultBranch, "Fast-forward")) {
            Update-DefaultBranch $defaultBranch
        }
    }
}
