/**
 * Erreurs métier standardisées (README §72).
 * Format de réponse : { success:false, error:{ code, message, details, correlationId } }
 * Jamais de stack trace au client.
 */
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export class NotFoundError extends DomainError {
  constructor(resource: string, id?: string) {
    super('NOT_FOUND', `${resource} introuvable${id ? ` : ${id}` : ''}`, 404);
  }
}

export class ForbiddenError extends DomainError {
  constructor(permission?: string) {
    super(
      'FORBIDDEN',
      permission ? `Permission requise : ${permission}` : 'Accès refusé',
      403,
    );
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message = 'Authentification requise') {
    super('UNAUTHORIZED', message, 401);
  }
}

export class ValidationError extends DomainError {
  constructor(details: Record<string, unknown>, message = 'Données invalides') {
    super('VALIDATION_ERROR', message, 422, details);
  }
}

// Codes métier spécifiques PMS
export const BizError = {
  roomNotAvailable: (roomId: string) =>
    new DomainError('ROOM_NOT_AVAILABLE', 'La chambre sélectionnée n\'est plus disponible.', 409, { roomId }),
  roomTypeSoldOut: (roomTypeId: string, date: string) =>
    new DomainError('ROOM_TYPE_SOLD_OUT', 'Plus de chambre disponible pour ce type à cette date.', 409, { roomTypeId, date }),
  roomNotAssignable: (roomId: string, reason: string) =>
    new DomainError('ROOM_NOT_ASSIGNABLE', `Chambre non assignable (${reason}).`, 400, { roomId, reason }),
  doubleBookingBlocked: () =>
    new DomainError('DOUBLE_BOOKING_BLOCKED', 'Conflit d\'inventaire : la dernière chambre a été réservée simultanément par un autre utilisateur.', 409),
  invalidStateTransition: (entity: string, from: string, to: string) =>
    new DomainError('INVALID_STATE_TRANSITION', `Transition d'état interdite : ${entity} ${from} → ${to}.`, 409, { entity, from, to }),
  folioClosed: (folioId: string) =>
    new DomainError('FOLIO_CLOSED', 'Ce folio est clôturé : aucune écriture supplémentaire autorisée.', 409, { folioId }),
  invoiceFinalized: (invoiceId: string) =>
    new DomainError('INVOICE_FINALIZED', 'Facture finalisée : elle ne peut plus être modifiée librement (règle 7).', 409, { invoiceId }),
  checkoutBlockedUnpaidBalance: (balance: number, currency: string) =>
    new DomainError('CHECKOUT_BALANCE_DUE', `Solde impayé : ${balance} ${currency}. Nécessite la permission stay.checkout_with_balance.`, 409, { balance, currency }),
  paymentExceedsBalance: (amount: number, balance: number) =>
    new DomainError('PAYMENT_EXCEEDS_BALANCE', 'Le paiement dépasse le solde dû sans politique overpayment explicite.', 400, { amount, balance }),
  rateOverrideForbidden: (pct: number, limit: number) =>
    new DomainError('RATE_OVERRIDE_FORBIDDEN', 'Modification tarifaire au-delà de votre limite d\'override.', 403, { pct, limit }),
  creditLimitExceeded: (companyId: string, limit: number, outstanding: number) =>
    new DomainError('CREDIT_LIMIT_EXCEEDED', 'Limite de crédit entreprise dépassée.', 409, { companyId, limit, outstanding }),
  nightAuditAlreadyCompleted: (businessDate: string) =>
    new DomainError('NIGHT_AUDIT_ALREADY_COMPLETED', `Night audit déjà clôturé pour ${businessDate} (idempotent).`, 409, { businessDate }),
  nightAuditRunningElsewhere: () =>
    new DomainError('NIGHT_AUDIT_RUNNING', 'Un night audit est déjà en cours pour cette propriété.', 409),
  fneSubmissionFailed: (reason: string) =>
    new DomainError('FNE_SUBMISSION_FAILED', `Échec de soumission FNE : ${reason}`, 502, { reason }),
  cashSessionAlreadyOpen: (sessionId: string) =>
    new DomainError('CASH_SESSION_ALREADY_OPEN', 'Une session de caisse est déjà ouverte pour cet utilisateur sur cette propriété.', 409, { sessionId }),
  duplicateRequest: (key: string) =>
    new DomainError('DUPLICATE_REQUEST', 'Requête dupliquée ignorée grâce à la clé d\'idempotence.', 200, { key }),
  tenantMismatch: () =>
    new DomainError('TENANT_MISMATCH', 'Ressource appartenant à un autre tenant (isolation locataire).', 403),
  accountLocked: () =>
    new DomainError('ACCOUNT_LOCKED', 'Compte temporairement verrouillé après trop d\'échecs de connexion.', 429),
};
