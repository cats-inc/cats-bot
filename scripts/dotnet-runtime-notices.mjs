// Bot adapter for the pinned shared .NET notice mechanism.
export * from './shared/dotnet-runtime-notices.mjs';
import { renderNoticesReadme as render, stageDotnetRuntimeNotices as stage } from './shared/dotnet-runtime-notices.mjs';
const applicationNotice = 'Cats Bot itself is licensed separately; see resources/app/LICENSE in the installed application.';
export const renderNoticesReadme = options => render({ ...options, applicationNotice });
export const stageDotnetRuntimeNotices = options => stage({ ...options, applicationNotice });
