// Grenzen per gebruiker en per project. Zonder grenzen kan één account (of één lid van een gedeeld project) de server en de
// sync van anderen vertragen of vol zetten. De waarden zijn ruim voor persoonlijk en gezamenlijk gebruik; ze staan in
// SPEC.md (hoofdstuk 4a, "Limieten"). De server meldt een bereikte grens met LIMIT_REACHED en een duidelijke tekst.
//
// Het is bewust een gewoon object: tests zetten een waarde tijdelijk lager om de grens te bereiken zonder duizenden rijen.

export const LIMITS = {
  /** Projecten waar iemand eigenaar van is (de Inbox telt mee). */
  projectsPerUser: 500,
  sectionsPerProject: 200,
  /** Taken (ook afgevinkte, niet de verwijderde) per project, en per aanmaker over alle projecten. */
  tasksPerProject: 10_000,
  tasksPerUser: 50_000,
  labelsPerUser: 500,
  filtersPerUser: 200,
  /** Opmerkingen per taak, en bij een project. */
  commentsPerParent: 500,
  /** Herinneringen die iemand zelf bij één taak heeft, en in totaal. */
  /** Bijlagen per taak (de grootte per bestand en per gebruiker staan in de omgeving: MAX_UPLOAD_MB en ATTACHMENT_QUOTA_MB). */
  attachmentsPerTask: 20,
  remindersPerTask: 20,
  remindersPerUser: 5_000,
  /** Plaatsen (voor herinneringen op een locatie) per gebruiker. */
  placesPerUser: 100,
  membersPerProject: 100,
  /** Aangemelde apparaten; bij het inloggen op een volgend apparaat wordt het langst ongebruikte afgemeld. */
  sessionsPerUser: 20,
  /** Gelijktijdige live-verbindingen (SSE) per gebruiker; een volgende wordt geweigerd. */
  sseConnectionsPerUser: 20,
};

export type LimitName = keyof typeof LIMITS;
