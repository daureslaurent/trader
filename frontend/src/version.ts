// Typed, app-wide access to the build version.
// The numbers live in version.json, which the pre-commit hook bumps on every commit.
import data from './version.json'

export const APP_VERSION: string = data.version
export const APP_BUILD: number = data.build
export const APP_DATE: string = data.date
