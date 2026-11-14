// Rollen in een gedeeld project, gedeeld door server, web-app en demo (zie SPEC.md, hoofdstuk 5, "Rechten"):
//   owner   de eigenaar: beheert het project en de leden, en werkt erin
//   member  lid, kan bewerken: werkt in het project (taken, secties, bijlagen, opmerkingen)
//   viewer  lezer, alleen lezen: ziet alles van het project, plaatst opmerkingen, zet eigen herinneringen en kan vertrekken,
//           maar wijzigt niets aan taken, secties of het project, en kan niet worden toegewezen
// Wat een lezer niet mag, weigert de server met FORBIDDEN; de reducer van de app voert het dan ook niet optimistisch uit.

/** Alle rollen, van meer naar minder rechten. */
export const ROLES = ['owner', 'member', 'viewer'];

/** De rollen die de eigenaar bij delen kan kiezen (eigenaarschap overdragen bestaat niet). */
export const SHARE_ROLES = ['member', 'viewer'];

/** De standaardrol bij delen: zoals vóór er rollen waren, kan een nieuw lid bewerken. */
export const DEFAULT_SHARE_ROLE = 'member';

/** Mag iemand met deze rol taken, secties en het project wijzigen? (`null` = geen lid) */
export const canEditRole = (role) => role === 'owner' || role === 'member';

/** Mag iemand met deze rol een taak toegewezen krijgen? Alleen wie ook kan bewerken. */
export const canBeAssignedRole = canEditRole;

/** Controle van een rol bij `project_share` en `member_update`: een rol die je kunt geven, of een foutmelding. */
export function shareRoleProblem(role) {
  return SHARE_ROLES.includes(role) ? null : `role moet ${SHARE_ROLES.map((r) => `"${r}"`).join(' of ')} zijn`;
}
