# MASTER PROMPT — CONSTRUCTION D'UN PMS HÔTELIER PROFESSIONNEL

## Côte d’Ivoire — V1 Production Ready

Tu es un **Principal Software Architect + Senior Full-Stack Engineer + Product Engineer spécialisé dans les Property Management Systems (PMS) hôteliers**.

Ta mission est de transformer le dashboard/template actuellement présent dans ce projet en une **application complète de gestion hôtelière professionnelle (PMS)** destinée en priorité aux hôtels de Côte d’Ivoire.

L'application doit être conçue comme un véritable produit SaaS production-ready, et non comme une simple démonstration UI.

---

# 1. OBJECTIF DU PRODUIT

Construire un PMS permettant à un hôtel de gérer son activité quotidienne depuis une seule application :

* configuration de l'établissement ;
* chambres et types de chambres ;
* disponibilité ;
* tarifs ;
* réservations ;
* clients ;
* entreprises/agences ;
* réception ;
* check-in ;
* check-out ;
* séjours ;
* folios ;
* prestations ;
* facturation ;
* paiements ;
* caisse ;
* taxe communale de nuitée ;
* intégration FNE/RNE ;
* housekeeping ;
* maintenance ;
* night audit ;
* clôture journalière ;
* reporting ;
* utilisateurs ;
* rôles et permissions ;
* journal d'audit.

Le produit doit être extensible ultérieurement vers :

* POS restaurant ;
* POS bar ;
* room service ;
* stock ;
* achats ;
* fournisseurs ;
* channel manager ;
* Booking Engine ;
* OTA ;
* CRM ;
* fidélité ;
* WhatsApp ;
* Mobile Money ;
* comptabilité ;
* revenue management ;
* intelligence artificielle ;
* multi-hôtels.

Ces modules futurs ne doivent pas être développés complètement dans le V1, mais l'architecture du V1 doit permettre leur ajout sans refonte du cœur métier.

---

# 2. RÈGLE FONDAMENTALE

NE PAS construire une simple interface de dashboard avec des données fictives.

Toutes les fonctionnalités principales doivent fonctionner réellement :

UI
→ API
→ domaine métier
→ validation
→ transaction
→ PostgreSQL
→ événements
→ audit
→ notifications
→ reporting.

Aucun bouton fonctionnel ne doit simplement afficher un toast du type "Coming soon" lorsqu'il est présenté comme disponible.

Ne pas créer de fake data dans le code sauf pour le seed/demo explicitement séparé.

---

# 3. INSTRUCTIONS CONCERNANT LE TEMPLATE EXISTANT

Avant de modifier le projet :

1. Inspecter entièrement le repository.
2. Identifier :

   * framework ;
   * version ;
   * système de routing ;
   * composants UI ;
   * design system ;
   * thème ;
   * gestion des icônes ;
   * tableaux ;
   * formulaires ;
   * charts ;
   * layouts ;
   * authentification existante ;
   * gestion API existante ;
   * ORM éventuel ;
   * système de state management.
3. Réutiliser autant que possible l'existant.
4. Ne pas remplacer inutilement le template.
5. Conserver son identité visuelle.
6. Adapter l'application métier au design existant.
7. Ne jamais dupliquer des composants lorsqu'un composant réutilisable existe déjà.

Si le template est compatible avec Next.js/React/TypeScript, conserver cette stack pour le frontend.

Si une stack différente existe déjà et qu'elle est techniquement saine, la conserver au lieu de procéder à une migration inutile.

---

# 4. ARCHITECTURE TECHNIQUE CIBLE

Architecture recommandée :

```text
hotel-pms/
│
├── apps/
│   ├── web/
│   │   └── Next.js / React / TypeScript
│   │
│   └── api/
│       └── NestJS / TypeScript
│
├── packages/
│   ├── ui/
│   ├── config/
│   ├── types/
│   ├── validation/
│   ├── domain/
│   └── database/
│
├── infrastructure/
│   ├── docker/
│   ├── nginx/
│   ├── monitoring/
│   └── scripts/
│
├── docs/
│
└── tests/
```

Architecture logique :

```text
                    WEB / PWA
                       │
                       ▼
                 API / BFF
                       │
                       ▼
              APPLICATION LAYER
                       │
                       ▼
                 DOMAIN LAYER
                       │
        ┌──────────────┼──────────────┐
        │              │              │
   PostgreSQL        Redis          Queue
        │                             │
        │                         BullMQ
        │                             │
        └──────────────┬──────────────┘
                       │
                       ▼
                EVENT / JOBS
                       │
          ┌────────────┼────────────┐
          │            │            │
         FNE       Notifications   Reports
```

Architecture backend :

```text
modules/
├── auth
├── organizations
├── properties
├── rooms
├── room-types
├── rates
├── guests
├── companies
├── agencies
├── reservations
├── stays
├── front-office
├── folios
├── charges
├── payments
├── invoices
├── taxes
├── fne
├── housekeeping
├── maintenance
├── cash-management
├── night-audit
├── reports
├── notifications
├── users
├── roles
├── permissions
├── audit
└── system
```

Utiliser une architecture **modular monolith** au V1.

NE PAS créer de microservices indépendants pour chaque module.

Le système doit être organisé de manière à pouvoir extraire certains modules en microservices ultérieurement si l'échelle l'exige.

---

# 5. STACK TECHNIQUE RECOMMANDÉE

Utiliser, sauf incompatibilité forte avec le template existant :

## Frontend

* Next.js
* React
* TypeScript
* Tailwind CSS ou le design system existant
* React Hook Form
* Zod
* TanStack Query
* PWA
* IndexedDB pour les capacités offline limitées

## Backend

* NestJS
* TypeScript
* REST API
* OpenAPI/Swagger
* WebSockets/SSE pour les événements temps réel

## Base de données

* PostgreSQL

ORM :

* Prisma si le projet existant l'utilise ;
* sinon privilégier un ORM permettant un contrôle précis des transactions PostgreSQL.

## Cache

* Redis

## Jobs

* BullMQ / Redis

## Stockage fichiers

* S3 compatible object storage.

## Tests

* Vitest/Jest pour unit/integration
* Playwright pour E2E

## Infrastructure

* Docker
* Docker Compose pour développement
* CI/CD
* migrations versionnées
* backups
* observabilité.

---

# 6. PRINCIPES ARCHITECTURAUX NON NÉGOCIABLES

## Argent

NE JAMAIS stocker l'argent en FLOAT/DOUBLE.

Utiliser :

```text
BIGINT
```

pour les montants en XOF lorsque le modèle de données est mono-devise.

Exemple :

```text
50000
```

représente :

```text
50 000 FCFA
```

Prévoir néanmoins `currency_code` afin de permettre ultérieurement d'autres devises.

---

## Dates

Toutes les dates/heures techniques doivent être stockées en UTC avec conversion vers le timezone de l'établissement.

Chaque propriété doit posséder :

```text
timezone
```

Pour la Côte d'Ivoire :

```text
Africa/Abidjan
```

Ne jamais utiliser `new Date()` directement comme règle métier sans tenir compte du timezone de la propriété.

Les opérations hôtelières doivent disposer d'une notion de :

```text
business_date
```

distincte du timestamp technique.

---

# 7. MULTI-TENANCY

Préparer immédiatement le système à plusieurs établissements.

Structure :

```text
Organization
    │
    ├── Property A
    │
    ├── Property B
    │
    └── Property C
```

Toutes les entités opérationnelles importantes doivent être associées à une organisation et/ou une propriété.

Il doit être impossible pour :

```text
hotel_A
```

de consulter ou modifier :

```text
hotel_B
```

même en manipulant directement les IDs API.

Ne jamais faire confiance au `propertyId` envoyé par le frontend.

Le backend doit toujours dériver le contexte depuis l'utilisateur authentifié et vérifier les permissions.

---

# 8. BASE DE DONNÉES — MODÈLE COMPLET V1

Créer un modèle PostgreSQL professionnel.

Ne pas utiliser une seule table géante.

---

## 8.1 organizations

```text
id
name
legal_name
slug
status
default_currency
country_code
created_at
updated_at
deleted_at
```

---

## 8.2 properties

```text
id
organization_id
name
code
slug
legal_name
rccm
tax_identifier
address_line1
address_line2
city
region
district
postal_code
country
phone
email
website
timezone
currency
hotel_classification
star_rating
check_in_time
check_out_time
status
logo_url
created_at
updated_at
deleted_at
```

---

## 8.3 property_settings

```text
id
property_id
key
value
value_type
created_at
updated_at
```

Éviter de mettre toutes les configurations métier dans un JSON sans structure.

Les paramètres critiques doivent avoir une vraie structure ou des tables dédiées.

---

# 9. STRUCTURE PHYSIQUE

## buildings

```text
id
property_id
name
code
description
created_at
updated_at
```

## floors

```text
id
property_id
building_id
name
number
created_at
updated_at
```

## amenities

```text
id
property_id
name
code
description
created_at
```

## room_types

```text
id
property_id
name
code
description
short_description
capacity_adults
capacity_children
max_occupancy
base_occupancy
bed_configuration
surface_area
default_rate
status
created_at
updated_at
deleted_at
```

## rooms

```text
id
property_id
building_id
floor_id
room_type_id
number
code
status
housekeeping_status
front_office_status
maintenance_status
floor_location
capacity
notes
created_at
updated_at
deleted_at
```

Créer des tables de liaison :

```text
room_amenities
room_type_amenities
```

---

# 10. HISTORIQUE DES STATUTS DES CHAMBRES

## room_status_history

```text
id
property_id
room_id
previous_status
new_status
reason
reference_type
reference_id
changed_by
created_at
```

Ne jamais simplement modifier un statut sans laisser de trace lorsqu'il s'agit d'une transition opérationnelle importante.

---

# 11. TARIFICATION

## rate_plans

```text
id
property_id
name
code
description
meal_plan
cancellation_policy_id
payment_policy
is_refundable
is_public
is_active
created_at
updated_at
```

Exemples :

```text
BAR
CORPORATE
AGENCY
NON_REFUNDABLE
PROMO
LONG_STAY
```

## seasons

```text
id
property_id
name
start_date
end_date
priority
is_active
```

## rate_plan_prices

```text
id
property_id
rate_plan_id
room_type_id
season_id
valid_from
valid_to
occupancy
amount
currency
minimum_nights
maximum_nights
created_at
updated_at
```

Le moteur tarifaire doit être séparé du frontend.

---

# 12. POLITIQUES D'ANNULATION

## cancellation_policies

```text
id
property_id
name
description
deadline_hours
penalty_type
penalty_value
no_show_penalty_type
no_show_penalty_value
created_at
updated_at
```

Types :

```text
NONE
FIXED_AMOUNT
FIRST_NIGHT
PERCENTAGE
FULL_STAY
```

---

# 13. CLIENTS

## guests

```text
id
property_id
guest_code
first_name
last_name
middle_name
display_name
gender
date_of_birth
nationality
country
phone
secondary_phone
email
address
city
region
company_id
vip_level
notes
marketing_consent
created_at
updated_at
deleted_at
```

NE PAS supprimer physiquement un client ayant des transactions historiques.

---

# 14. DOCUMENTS CLIENT

## guest_documents

```text
id
guest_id
document_type
document_number
issuing_country
issue_date
expiry_date
file_url
verified_at
verified_by
created_at
updated_at
```

Les numéros de documents personnels doivent être traités comme données sensibles.

Ne pas les afficher en clair partout.

---

# 15. PRÉFÉRENCES CLIENT

## guest_preferences

```text
id
guest_id
preference_type
preference_value
notes
created_at
updated_at
```

Exemples :

```text
ROOM_FLOOR
BED
DIET
PILLOW
QUIET_ROOM
SMOKING
```

---

# 16. ENTREPRISES

## companies

```text
id
property_id
name
legal_name
rccm
tax_identifier
phone
email
address
city
country
contact_person
payment_terms
credit_limit
status
notes
created_at
updated_at
deleted_at
```

---

# 17. AGENCES

## agencies

Même modèle conceptuel que les entreprises :

```text
id
property_id
name
legal_name
registration_number
phone
email
address
commission_type
commission_value
payment_terms
status
created_at
updated_at
```

---

# 18. RÉSERVATIONS

## reservations

```text
id
property_id
reservation_number
source
channel
status
guest_id
company_id
agency_id
arrival_date
departure_date
nights
adults
children
infants
currency
subtotal
discount_amount
tax_amount
total_amount
deposit_required
deposit_amount
deposit_due_date
special_requests
internal_notes
external_reference
created_by
updated_by
created_at
updated_at
cancelled_at
cancellation_reason
```

Statuts :

```text
DRAFT
OPTION
CONFIRMED
WAITLISTED
CANCELLED
NO_SHOW
CHECKED_IN
CHECKED_OUT
CLOSED
```

Sources :

```text
DIRECT
PHONE
WHATSAPP
WALK_IN
WEBSITE
OTA
AGENCY
CORPORATE
OTHER
```

---

# 19. LIGNES DE RÉSERVATION

## reservation_rooms

```text
id
reservation_id
room_type_id
room_id nullable
rate_plan_id
adults
children
arrival_date
departure_date
number_of_nights
base_amount
discount_amount
tax_amount
total_amount
status
created_at
updated_at
```

IMPORTANT :

Une réservation doit pouvoir réserver un `room_type` sans avoir immédiatement une chambre physique.

---

# 20. CLIENTS D'UNE RÉSERVATION

## reservation_guests

```text
id
reservation_id
guest_id
role
is_primary
created_at
```

Rôles :

```text
PRIMARY
ADULT
CHILD
COMPANION
```

---

# 21. SÉJOUR

Ne pas confondre réservation et séjour.

Créer :

## stays

```text
id
property_id
stay_number
reservation_id
primary_guest_id
status
actual_check_in_at
actual_check_out_at
planned_check_in
planned_check_out
assigned_by
checked_in_by
checked_out_by
created_at
updated_at
```

Statuts :

```text
EXPECTED
CHECKED_IN
IN_HOUSE
CHECKED_OUT
CANCELLED
```

---

# 22. CHAMBRES DU SÉJOUR

## stay_rooms

```text
id
stay_id
room_id
room_type_id
arrival_date
departure_date
assigned_at
assigned_by
released_at
```

Cela permet :

* changement de chambre ;
* upgrade ;
* transfert ;
* split de séjour ;
* plusieurs chambres pour une réservation.

---

# 23. FOLIO

Le folio est l'un des objets centraux du PMS.

## folios

```text
id
property_id
folio_number
stay_id
guest_id
company_id
status
currency
opened_at
closed_at
balance
credit_limit
created_at
updated_at
```

Statuts :

```text
OPEN
PARTIALLY_PAID
PAID
CLOSED
```

---

# 24. FOLIO ITEMS

## folio_items

```text
id
folio_id
business_date
transaction_date
type
category
description
quantity
unit_amount
discount_amount
net_amount
tax_amount
gross_amount
currency
reference_type
reference_id
posted_by
voided_at
voided_by
void_reason
created_at
```

Types :

```text
ROOM
BREAKFAST
RESTAURANT
BAR
LAUNDRY
ROOM_SERVICE
SPA
OTHER_SERVICE
DISCOUNT
TAX
ADJUSTMENT
```

Un folio item financier ne doit jamais être physiquement supprimé.

Une correction doit être effectuée par une transaction compensatoire ou une opération de void autorisée.

---

# 25. PAIEMENTS

## payments

```text
id
property_id
payment_number
folio_id
amount
currency
method
status
reference
external_reference
paid_at
received_by
cash_session_id
notes
created_at
updated_at
```

Méthodes :

```text
CASH
CARD
BANK_TRANSFER
CHEQUE
MOBILE_MONEY
OTHER
```

Statuts :

```text
PENDING
AUTHORIZED
COMPLETED
FAILED
CANCELLED
REFUNDED
PARTIALLY_REFUNDED
```

---

# 26. AFFECTATION DES PAIEMENTS

## payment_allocations

```text
id
payment_id
folio_id
amount
created_at
```

Cela permet un paiement affecté à plusieurs folios.

---

# 27. REMBOURSEMENTS

## refunds

```text
id
payment_id
amount
reason
status
reference
approved_by
processed_by
created_at
```

Un remboursement important doit nécessiter une permission adaptée.

---

# 28. FACTURES

## invoices

```text
id
property_id
invoice_number
folio_id
guest_id
company_id
status
invoice_type
currency
subtotal
discount_amount
tax_amount
total_amount
amount_paid
balance_due
issued_at
due_at
fne_status
fne_reference
fne_number
created_by
created_at
updated_at
```

Statuts :

```text
DRAFT
FINALIZED
SUBMITTED
CERTIFIED
REJECTED
CANCELLED
CREDITED
```

---

# 29. LIGNES DE FACTURE

## invoice_items

```text
id
invoice_id
description
quantity
unit_price
discount_amount
net_amount
tax_amount
gross_amount
tax_code
reference_type
reference_id
```

---

# 30. TAXES

Créer un véritable moteur de taxation.

## tax_rules

```text
id
property_id
name
code
tax_type
jurisdiction
calculation_method
rate
fixed_amount
is_inclusive
effective_from
effective_to
conditions
is_active
created_at
updated_at
```

Ne jamais hardcoder les règles fiscales directement dans les composants UI.

---

# 31. TAXE COMMUNALE DE NUITÉE

Créer une configuration spécifique mais intégrée au moteur fiscal.

## night_tax_configurations

```text
id
property_id
hotel_classification
amount_per_night
jurisdiction_type
beneficiary_type
effective_from
effective_to
is_active
```

Prévoir le classement :

```text
NO_STAR
ONE_STAR
TWO_STAR
THREE_STAR_PLUS
```

Le montant doit être configurable.

Pour le paramétrage 2026 en Côte d’Ivoire :

```text
sans étoile      = 500 FCFA
1 étoile         = 1 000 FCFA
2 étoiles        = 1 500 FCFA
3 étoiles et +   = 2 000 FCFA
```

Ne pas hardcoder ces valeurs dans le frontend.

Les stocker dans les données de configuration avec une date d'effet.

---

# 32. OBLIGATIONS FISCALES

Créer :

## tax_obligations

```text
id
property_id
tax_type
period_start
period_end
amount_due
amount_declared
amount_paid
status
due_date
submitted_at
created_at
updated_at
```

Cela permettra notamment de suivre les taxes de nuitée collectées et à reverser.

---

# 33. FNE

Créer une couche d'abstraction :

```text
FNEProvider
```

avec une implémentation :

```text
FNEApiProvider
```

NE PAS mettre les appels FNE directement dans InvoiceService.

Architecture :

```text
Invoice
   ↓
InvoiceService
   ↓
FNEService
   ↓
FNEProvider
   ↓
DGI FNE API
```

Créer :

## fne_documents

```text
id
property_id
invoice_id
external_reference
submission_status
fne_number
certification_reference
qr_code_data
submitted_at
certified_at
rejected_at
rejection_reason
created_at
updated_at
```

## fne_submission_attempts

```text
id
fne_document_id
attempt_number
request_id
status
response_code
response_body_sanitized
error_code
error_message
created_at
```

Statuts :

```text
PENDING
PROCESSING
CERTIFIED
REJECTED
RETRYING
FAILED
CANCELLED
```

NE JAMAIS supposer qu'une facture est certifiée simplement parce que la requête API a été envoyée.

La certification doit dépendre de la réponse officielle de la plateforme.

Mettre en place :

* idempotency ;
* retry ;
* exponential backoff ;
* timeout ;
* circuit breaker ;
* logs ;
* correlation ID ;
* mode sandbox/mock pour les tests ;
* configuration séparée dev/staging/production.

Ne jamais committer les credentials FNE.

Les URLs, identifiants et paramètres exacts de l'API doivent être configurés à partir de la documentation officielle FNE actuellement en vigueur et non inventés dans le code.

---

# 34. CAISSE

Créer :

## cash_registers

```text
id
property_id
name
code
location
is_active
```

## cash_sessions

```text
id
cash_register_id
user_id
opened_at
opening_balance
closing_balance
expected_balance
difference
status
closed_at
closed_by
```

Statuts :

```text
OPEN
CLOSING
CLOSED
```

## cash_movements

```text
id
cash_session_id
type
amount
reason
reference_type
reference_id
created_by
created_at
```

Types :

```text
SALE
PAYMENT
REFUND
CASH_IN
CASH_OUT
ADJUSTMENT
```

---

# 35. HOUSEKEEPING

## housekeeping_tasks

```text
id
property_id
room_id
task_type
priority
status
assigned_to
started_at
completed_at
verified_at
verified_by
notes
created_at
updated_at
```

Types :

```text
CHECKOUT_CLEAN
STAYOVER
DEEP_CLEAN
INSPECTION
VIP_PREP
MAINTENANCE_FOLLOWUP
```

Statuts :

```text
PENDING
ASSIGNED
IN_PROGRESS
COMPLETED
INSPECTED
BLOCKED
```

---

# 36. HOUSEKEEPING WORKFLOW

Lorsqu'un client effectue un checkout :

```text
CHECKED_OUT
      ↓
ROOM = DIRTY
      ↓
HOUSEKEEPING TASK CREATED
      ↓
AGENT ASSIGNED
      ↓
CLEANING
      ↓
COMPLETED
      ↓
SUPERVISOR INSPECTION
      ↓
ROOM = CLEAN
      ↓
ROOM = AVAILABLE
```

Une chambre ne doit pas être considérée comme disponible simplement parce que le client est parti.

---

# 37. MAINTENANCE

## assets

```text
id
property_id
room_id nullable
name
category
serial_number
manufacturer
purchase_date
warranty_end
status
created_at
updated_at
```

## maintenance_tickets

```text
id
property_id
room_id
asset_id
title
description
priority
status
reported_by
assigned_to
estimated_cost
actual_cost
opened_at
resolved_at
closed_at
created_at
updated_at
```

Statuts :

```text
OPEN
ASSIGNED
IN_PROGRESS
WAITING_PART
RESOLVED
CLOSED
```

---

# 38. CHAMBRE HORS SERVICE

Le système doit permettre :

```text
OUT_OF_ORDER
```

et :

```text
OUT_OF_SERVICE
```

Différence :

```text
OUT_OF_ORDER
= problème technique temporaire.

OUT_OF_SERVICE
= chambre bloquée pour raison opérationnelle plus longue.
```

Une chambre dans ces états ne doit pas pouvoir être attribuée automatiquement.

---

# 39. UTILISATEURS

## users

```text
id
organization_id
first_name
last_name
email
phone
username
password_hash
status
last_login_at
mfa_enabled
created_at
updated_at
deleted_at
```

---

# 40. RÔLES

## roles

```text
id
organization_id
name
code
description
is_system_role
```

Créer au minimum :

```text
SUPER_ADMIN
OWNER
GENERAL_MANAGER
FRONT_DESK_MANAGER
RECEPTIONIST
CASHIER
HOUSEKEEPING_SUPERVISOR
HOUSEKEEPER
MAINTENANCE
ACCOUNTANT
AUDITOR
```

---

# 41. PERMISSIONS

## permissions

```text
id
resource
action
description
```

Exemples :

```text
reservation.create
reservation.update
reservation.cancel
reservation.override_price
reservation.no_show

stay.check_in
stay.check_out
stay.change_room

folio.view
folio.post_charge
folio.adjust
folio.void

payment.create
payment.refund
payment.delete

invoice.create
invoice.finalize
invoice.cancel

fne.submit
fne.retry

housekeeping.assign
housekeeping.complete

night_audit.run
night_audit.close

reports.view
settings.manage
users.manage
```

Ne pas coder les permissions directement avec des `if role === "admin"`.

---

# 42. JOURNAL D'AUDIT

## audit_logs

```text
id
organization_id
property_id
user_id
action
resource
resource_id
before_data
after_data
ip_address
user_agent
correlation_id
created_at
```

Auditer obligatoirement :

* connexion ;
* déconnexion ;
* création réservation ;
* modification réservation ;
* annulation ;
* changement tarif ;
* remise ;
* check-in ;
* changement chambre ;
* check-out ;
* ajout charge ;
* void ;
* paiement ;
* remboursement ;
* facture ;
* certification FNE ;
* modification configuration fiscale ;
* modification permissions ;
* clôture caisse ;
* night audit.

---

# 43. WORKFLOW — CONFIGURATION INITIALE

Lorsqu'un hôtel est créé :

```text
Organization
      ↓
Property
      ↓
Informations légales
      ↓
Classement hôtelier
      ↓
Timezone
      ↓
Devise
      ↓
Bâtiments
      ↓
Étages
      ↓
Types de chambres
      ↓
Chambres
      ↓
Tarifs
      ↓
Politiques
      ↓
Taxes
      ↓
Utilisateurs
      ↓
Caisses
      ↓
Configuration terminée
```

Créer un assistant d'installation.

---

# 44. WORKFLOW — CRÉATION D'UNE RÉSERVATION

```text
Recherche disponibilité
        ↓
Sélection dates
        ↓
Sélection type chambre
        ↓
Sélection tarif
        ↓
Nombre de personnes
        ↓
Client existant ?
      /     \
    OUI      NON
     ↓        ↓
Sélection   création
profil      profil
      \      /
       ↓
Préférences
       ↓
Demandes spéciales
       ↓
Calcul prix
       ↓
Taxes
       ↓
Acompte éventuel
       ↓
Création réservation
       ↓
Confirmation
       ↓
Mise à jour disponibilité
       ↓
Notification
```

---

# 45. RÈGLE DE DISPONIBILITÉ

Le système doit compter les chambres réellement disponibles.

Ne pas simplement compter toutes les chambres qui ne sont pas occupées.

Tenir compte de :

```text
RESERVED
OCCUPIED
BLOCKED
OUT_OF_ORDER
OUT_OF_SERVICE
MAINTENANCE
```

La disponibilité doit être calculée par :

```text
property
+
room_type
+
date range
```

Prévenir les doubles réservations.

Utiliser des transactions et des mécanismes PostgreSQL appropriés pour gérer la concurrence.

Tester explicitement le cas :

```text
Deux utilisateurs
+
même chambre
+
même seconde
```

---

# 46. WORKFLOW — MODIFICATION DE RÉSERVATION

Une réservation peut changer :

* dates ;
* nombre de personnes ;
* type chambre ;
* tarif ;
* chambre attribuée ;
* client ;
* entreprise ;
* agence ;
* demandes ;
* garantie.

Après modification :

```text
Recalculer disponibilité
Recalculer tarif
Recalculer taxes
Recalculer acompte
Créer audit log
Notifier si nécessaire
```

---

# 47. WORKFLOW — ANNULATION

```text
Demande annulation
       ↓
Calcul politique
       ↓
Pénalité éventuelle
       ↓
Acompte existant ?
       ↓
Calcul remboursement/crédit
       ↓
Confirmation
       ↓
Reservation = CANCELLED
       ↓
Libération inventaire
       ↓
Audit
```

---

# 48. WORKFLOW — NO SHOW

Lorsqu'une réservation n'est pas arrivée avant l'heure de cut-off :

```text
EXPECTED
   ↓
NO_SHOW
   ↓
Calcul pénalité
   ↓
Libération chambre
   ↓
Traitement acompte
   ↓
Audit
```

Le cut-off doit être configurable.

---

# 49. WORKFLOW — CHECK-IN

```text
Recherche réservation
       ↓
Vérification identité
       ↓
Vérification voyageurs
       ↓
Chambre attribuée ?
       ↓
NON → attribution
       ↓
Chambre propre ?
       ↓
NON → avertissement/blocage
       ↓
Garantie/paiement
       ↓
Signature / confirmation
       ↓
Création Stay
       ↓
Ouverture Folio
       ↓
Reservation = CHECKED_IN
       ↓
Room = OCCUPIED
       ↓
Notification
```

Le système doit refuser le check-in si une condition métier obligatoire n'est pas satisfaite, sauf override avec permission.

---

# 50. WORKFLOW — CHANGEMENT DE CHAMBRE

```text
Séjour actif
    ↓
Demande changement
    ↓
Recherche chambres disponibles
    ↓
Sélection
    ↓
Validation
    ↓
ancienne chambre libérée
    ↓
nouvelle chambre occupée
    ↓
stay_room créé
    ↓
audit
```

Le système doit conserver l'historique.

---

# 51. WORKFLOW — AJOUT DE CHARGE

Une prestation peut être ajoutée manuellement :

```text
Sélection folio
      ↓
Catégorie
      ↓
Description
      ↓
Quantité
      ↓
Prix
      ↓
Taxes
      ↓
Validation
      ↓
FolioItem
```

Une charge postée doit être immuable.

Une correction doit créer :

```text
VOID
+
corrective transaction
```

et non supprimer la transaction initiale.

---

# 52. WORKFLOW — FACTURATION

```text
Folio
 ↓
Toutes les charges récupérées
 ↓
Taxes calculées
 ↓
Réductions
 ↓
Solde
 ↓
Création facture
 ↓
Vérification
 ↓
Finalization
 ↓
Soumission FNE
 ↓
Certification
 ↓
Document final
```

---

# 53. WORKFLOW — PAIEMENT

```text
Payment intent
      ↓
Méthode
      ↓
Montant
      ↓
Référence
      ↓
Validation
      ↓
Payment = COMPLETED
      ↓
Allocation au folio
      ↓
Solde mis à jour
      ↓
Audit
```

Toutes les opérations financières doivent être transactionnelles.

---

# 54. WORKFLOW — CHECK-OUT

```text
Client demande départ
       ↓
Récupération folio
       ↓
Récupération charges en attente
       ↓
Minibar / prestations éventuelles
       ↓
Calcul taxes
       ↓
Calcul solde
       ↓
Solde > 0 ?
       ↓
Paiement
       ↓
Facturation
       ↓
FNE
       ↓
Validation départ
       ↓
Stay = CHECKED_OUT
       ↓
Room = DIRTY
       ↓
Housekeeping task
       ↓
Audit
```

Le système doit pouvoir empêcher le checkout avec solde impayé sauf permission `stay.checkout_with_balance`.

---

# 55. WORKFLOW — NIGHT AUDIT

Le Night Audit est une fonctionnalité centrale.

Avant de lancer :

```text
Vérifier caisse
Vérifier paiements
Vérifier transactions
Vérifier réservations
Vérifier arrivées
Vérifier départs
Vérifier folios
Vérifier anomalies
```

Puis :

```text
Poster automatiquement les charges nocturnes
       ↓
Calculer nuitées
       ↓
Calculer taxes
       ↓
Calculer CA
       ↓
Mettre à jour statistiques
       ↓
Produire rapports
       ↓
Clôturer business date
       ↓
Créer nouvelle business date
```

Créer :

## night_audits

```text
id
property_id
business_date
status
started_at
completed_at
started_by
completed_by
total_room_revenue
total_other_revenue
total_tax
total_payments
variance
error_summary
created_at
updated_at
```

Statuts :

```text
PENDING
RUNNING
COMPLETED
FAILED
CANCELLED
```

Le Night Audit doit être **idempotent**.

Il doit être impossible de poster deux fois les mêmes charges simplement parce qu'un opérateur a relancé le processus.

---

# 56. RECONCILIATION FINANCIÈRE

À la fin de la journée :

```text
CA PMS
+
CA caisse
+
paiements
+
remboursements
+
Mobile Money
+
cartes
+
virements
```

doivent pouvoir être comparés.

Afficher les écarts :

```text
EXPECTED
ACTUAL
VARIANCE
```

Exemple :

```text
Espèces attendues : 850 000
Espèces réelles   : 845 000
Écart              : -5 000
```

Une variance doit nécessiter une justification.

---

# 57. REPORTING V1

Dashboard direction :

```text
Occupation
ADR
RevPAR
Revenue chambres
Revenue total
Arrivées
Départs
Clients in-house
Annulations
No-show
Chambres disponibles
Chambres occupées
Chambres dirty
Chambres OOO
Solde clients
Paiements du jour
Taxes collectées
```

---

# 58. REPORTS V1

Créer au minimum :

## Rapport occupation

```text
date
room_type
available
occupied
out_of_order
occupancy_rate
```

## Revenue report

```text
business_date
room_revenue
other_revenue
discount
tax
gross_revenue
```

## Arrivals report

## Departures report

## In-house report

## No-show report

## Cancellation report

## Payment report

## Cashier report

## Folio balance report

## Tax report

## Night tax report

## FNE status report

## Housekeeping status report

## Maintenance report

## Audit report

Tous les rapports doivent être filtrables par :

```text
date
période
room type
source
rate plan
guest
company
agency
payment method
user
status
```

---

# 59. DASHBOARD

Le dashboard principal doit utiliser de vraies données.

Sections :

```text
TODAY
```

```text
Occupancy
ADR
RevPAR
Revenue
```

```text
Arrivals
Departures
In-house
No-show
```

```text
Room Status
Available
Occupied
Dirty
Cleaning
Maintenance
OOO
```

```text
Financial
Revenue
Payments
Outstanding
Taxes
```

```text
Tasks
Housekeeping
Maintenance
Pending payments
Pending FNE
```

---

# 60. ÉCRANS V1

Créer au minimum :

```text
/login

/dashboard

/front-desk

/room-plan

/reservations
/reservations/new
/reservations/[id]

/guests
/guests/[id]

/stays/[id]

/folios/[id]

/check-in
/check-out

/housekeeping
/housekeeping/[room]

/payments
/cashier

/invoices
/invoices/[id]

/taxes
/taxes/night-tax

/fne

/night-audit

/reports

/maintenance

/users
/roles

/settings
/settings/property
/settings/rooms
/settings/rates
/settings/taxes
/settings/payment-methods

/audit
```

---

# 61. FRONT DESK

Le module Front Desk doit être optimisé pour une utilisation extrêmement rapide.

Afficher :

```text
Today's Arrivals
Today's Departures
In-House
Available Rooms
Dirty Rooms
Late Checkouts
Early Arrivals
VIP
Unpaid Folios
```

Actions rapides :

```text
New Reservation
Walk-in
Check-in
Check-out
Find Guest
Find Reservation
Post Charge
Take Payment
Change Room
```

---

# 62. ROOM PLAN

Créer une vue calendrier type :

```text
          03    04    05    06    07

101       █████████
102          █████████
103       █████
201                 █████████
```

Possibilité :

* drag & drop ;
* changement chambre ;
* changement dates ;
* création réservation ;
* ouverture fiche séjour.

Tous les changements doivent passer par l'API et les règles métier.

---

# 63. HOUSEKEEPING BOARD

Colonnes :

```text
Dirty
Assigned
Cleaning
Ready for Inspection
Inspected
Available
Maintenance
```

Filtres :

```text
floor
building
room type
priority
employee
```

Mobile-friendly.

---

# 64. MOBILE / TABLETTE

L'application doit être parfaitement utilisable sur :

```text
Desktop
Laptop
Tablet
Mobile
```

Housekeeping doit avoir une UX mobile.

Ne pas simplement réduire le desktop.

---

# 65. OFFLINE

Créer une stratégie PWA.

Le frontend doit pouvoir conserver localement certaines données :

```text
room list
today arrivals
today departures
guest basic information
housekeeping tasks
```

Pour les mutations :

```text
Operation
 ↓
Local queue
 ↓
Idempotency key
 ↓
Sync
 ↓
API
 ↓
ACK
```

Les opérations financières à haut risque doivent signaler clairement lorsque l'action est hors ligne.

Ne jamais prétendre qu'un paiement externe a réellement été encaissé lorsque le réseau est indisponible.

---

# 66. NOTIFICATIONS

Créer un module :

```text
NotificationService
```

Canaux :

```text
IN_APP
EMAIL
WHATSAPP
SMS
```

Le V1 peut implémenter principalement :

```text
IN_APP
EMAIL
```

et préparer les adapters :

```text
WhatsAppProvider
SmsProvider
```

Événements :

```text
reservation.confirmed
reservation.cancelled
checkin.completed
checkout.completed
payment.completed
invoice.certified
housekeeping.completed
maintenance.created
maintenance.resolved
night_audit.completed
fne.rejected
```

---

# 67. EVENT SYSTEM

Créer des domain events.

Exemples :

```text
ReservationCreated
ReservationConfirmed
ReservationCancelled
GuestCheckedIn
GuestCheckedOut
RoomChanged
ChargePosted
ChargeVoided
PaymentCompleted
RefundCompleted
InvoiceFinalized
FNECertified
FNERejected
HousekeepingCompleted
MaintenanceCreated
MaintenanceResolved
NightAuditCompleted
```

Les événements permettent ensuite d'ajouter :

* notification ;
* reporting ;
* CRM ;
* WhatsApp ;
* intégrations ;
* analytics.

---

# 68. API

Toutes les opérations doivent être accessibles via API REST.

Exemples :

```text
POST /api/v1/auth/login

GET /api/v1/properties/:id

GET /api/v1/rooms
POST /api/v1/rooms

GET /api/v1/room-types

GET /api/v1/availability

GET /api/v1/reservations
POST /api/v1/reservations
GET /api/v1/reservations/:id
PATCH /api/v1/reservations/:id
POST /api/v1/reservations/:id/cancel

POST /api/v1/stays/:id/check-in
POST /api/v1/stays/:id/check-out
POST /api/v1/stays/:id/change-room

GET /api/v1/folios/:id
POST /api/v1/folios/:id/charges
POST /api/v1/folios/:id/payments

POST /api/v1/invoices
POST /api/v1/invoices/:id/finalize

POST /api/v1/fne/:invoiceId/submit
POST /api/v1/fne/:id/retry

GET /api/v1/housekeeping
POST /api/v1/housekeeping/:id/complete

POST /api/v1/night-audit/start
POST /api/v1/night-audit/complete

GET /api/v1/reports/...
```

Utiliser :

```text
/api/v1
```

comme version d'API.

---

# 69. API SECURITY

Toutes les mutations doivent vérifier :

```text
authentication
authorization
tenant
property
permission
input validation
business rules
```

Ne jamais faire confiance aux IDs du frontend.

Protéger contre :

* IDOR ;
* mass assignment ;
* SQL injection ;
* XSS ;
* CSRF si architecture concernée ;
* replay ;
* brute force ;
* privilege escalation.

Ajouter :

```text
rate limiting
request validation
security headers
secure cookies
CSRF protection si applicable
```

---

# 70. IDEMPOTENCY

Toutes les opérations susceptibles d'être répétées par :

* frontend ;
* mobile ;
* réseau instable ;
* webhook ;
* provider externe

doivent utiliser une clé d'idempotence.

Créer :

## idempotency_keys

```text
id
organization_id
key
operation
request_hash
response_status
response_body
expires_at
created_at
```

Cas critique :

```text
Paiement envoyé
 ↓
timeout réseau
 ↓
client clique encore
```

Le système ne doit pas créer deux paiements.

---

# 71. CONCURRENCY

Tester :

```text
Deux utilisateurs réservent simultanément la dernière chambre.
```

Résultat attendu :

```text
une seule opération réussit
l'autre reçoit une erreur métier contrôlée.
```

Même chose pour :

* attribution chambre ;
* paiement ;
* checkout ;
* night audit ;
* modification stock future ;
* émission facture.

---

# 72. ERREURS

Créer un format d'erreur API standard :

```json
{
  "success": false,
  "error": {
    "code": "ROOM_NOT_AVAILABLE",
    "message": "La chambre sélectionnée n'est plus disponible.",
    "details": {},
    "correlationId": "..."
  }
}
```

Ne jamais retourner des stack traces au client.

---

# 73. OBSERVABILITÉ

Chaque requête doit avoir :

```text
request_id
correlation_id
user_id
organization_id
property_id
```

Logs structurés JSON.

Logger :

```text
errors
security events
external calls
FNE calls
payment calls
night audit
critical business actions
```

Ne jamais logger :

```text
password
full payment credentials
secret API keys
sensitive document data
```

---

# 74. SECURITY / PRIVACY

Appliquer :

* principe du moindre privilège ;
* RBAC ;
* MFA pour profils sensibles ;
* chiffrement TLS ;
* chiffrement des secrets ;
* sauvegardes chiffrées ;
* audit ;
* rotation credentials ;
* sessions expirables ;
* suppression/anonymisation selon politique applicable ;
* protection des documents d'identité ;
* politique de conservation des données ;
* consentement marketing.

Prévoir dès le design les exigences de protection des données personnelles applicables en Côte d'Ivoire.

Ne pas créer de mécanisme de collecte de données personnelles non nécessaire à l'exploitation hôtelière.

---

# 75. BACKUPS

Production :

```text
daily full backup
point-in-time recovery
off-site backup
backup encryption
restore testing
retention policy
```

Le système doit documenter la procédure de restauration.

---

# 76. DATABASE MIGRATIONS

Toutes les modifications de schéma doivent passer par :

```text
migration
```

Jamais modifier manuellement la base de production sans migration versionnée.

Créer :

```text
001_initial
002_room_status
003_reservations
...
```

ou le système de migration de l'ORM choisi.

---

# 77. SEED

Créer un seed de démonstration séparé.

Exemple :

```text
Hotel Ivoire Demo
```

avec :

```text
3 room types
20 rooms
10 guests
10 reservations
5 companies
rates
tax configuration
users
permissions
sample folios
sample payments
```

Le seed ne doit jamais être exécuté automatiquement en production.

---

# 78. TESTS UNITAIRES

Tester les services :

```text
AvailabilityService
ReservationService
RateService
CheckInService
CheckoutService
FolioService
PaymentService
InvoiceService
TaxService
NightAuditService
HousekeepingService
FneService
```

Cas importants :

```text
prix correct
taxe correcte
double réservation
annulation
no-show
check-in
change room
charge
payment
refund
checkout
night audit
```

---

# 79. TESTS D'INTÉGRATION

Tester les transactions PostgreSQL.

Exemples :

```text
reservation → stay → folio → invoice → payment
```

et :

```text
checkout → housekeeping task → room status
```

---

# 80. TESTS E2E

Créer au minimum les scénarios :

## E2E 1 — Réservation complète

```text
Créer client
Créer réservation
Confirmer
Attribuer chambre
```

## E2E 2 — Check-in

```text
Réservation
→ Check-in
→ Stay
→ Folio
→ Chambre occupée
```

## E2E 3 — Consommation

```text
Folio
→ Charge
→ paiement
```

## E2E 4 — Checkout

```text
Stay
→ dernière charge
→ facture
→ paiement
→ checkout
→ housekeeping
```

## E2E 5 — Night Audit

```text
business date
→ night audit
→ clôture
→ nouveau business date
```

## E2E 6 — concurrence

```text
2 clients
→ dernière chambre
→ une réservation réussit
→ une échoue
```

---

# 81. RÈGLES MÉTIER CRITIQUES

Implémenter au minimum :

### Règle 1

Une chambre inactive/OOS/OOO ne doit jamais être attribuée.

### Règle 2

Une réservation annulée ne consomme plus d'inventaire.

### Règle 3

Un checkout place la chambre en état Dirty.

### Règle 4

Une chambre n'est Available qu'après les conditions housekeeping prévues.

### Règle 5

Une transaction financière ne doit jamais être supprimée physiquement.

### Règle 6

Un paiement ne peut pas dépasser le montant autorisé sans règle explicite d'overpayment.

### Règle 7

Une facture finalisée ne peut plus être librement modifiée.

### Règle 8

Une opération FNE doit être idempotente.

### Règle 9

Le Night Audit est idempotent.

### Règle 10

Toutes les opérations sensibles sont auditées.

---

# 82. UI DESIGN

Utiliser le template existant.

Principes :

```text
Fast
Clean
Dense but readable
Professional
Operational
Responsive
Accessible
```

Le PMS est utilisé par des employés qui doivent effectuer beaucoup d'actions chaque jour.

Ne pas multiplier les modals inutiles.

Utiliser :

* drawers ;
* command palette ;
* keyboard shortcuts ;
* quick actions ;
* bulk actions ;
* filters ;
* sticky headers ;
* contextual actions.

---

# 83. UX FRONT DESK

Le réceptionniste doit pouvoir :

```text
F2 → nouvelle réservation
F3 → rechercher client
F4 → recherche réservation
F5 → check-in
F6 → check-out
```

Si compatible avec le template/browser.

Prévoir également recherche globale :

```text
Nom
Téléphone
Email
N° réservation
N° chambre
N° facture
```

---

# 84. SEARCH

Créer une recherche globale.

Résultats :

```text
Guests
Reservations
Rooms
Folios
Invoices
Companies
```

---

# 85. FILTERING

Tous les tableaux importants doivent avoir :

```text
search
date range
status
sort
pagination
column visibility
export
```

Utiliser pagination serveur.

Ne pas charger 100 000 lignes dans le navigateur.

---

# 86. EXPORT

Prévoir :

```text
CSV
Excel
PDF
```

pour les rapports principaux.

Les exports doivent respecter les permissions de l'utilisateur.

---

# 87. PDF

Créer :

```text
invoice PDF
receipt PDF
reservation confirmation PDF
guest folio PDF
night audit report
tax report
```

Les templates doivent être personnalisables par établissement :

```text
logo
address
contacts
legal information
footer
```

---

# 88. AUDIT UI

Créer une page :

```text
Audit Log
```

Filtres :

```text
user
action
resource
date
property
severity
```

Afficher :

```text
Avant
Après
Utilisateur
Date
IP
Action
```

---

# 89. SETTINGS

Créer :

```text
Property
Rooms
Room Types
Rates
Policies
Taxes
Payments
Users
Roles
Notifications
Documents
FNE
Audit
System
```

Les paramètres financiers/fiscaux doivent exiger une permission élevée.

---

# 90. CONFIGURATION FISCALE

NE JAMAIS mettre :

```text
VAT = 18
```

directement dans un composant React.

Créer :

```text
TaxRule
```

avec dates d'effet.

Exemple :

```text
tax_type = VAT
rate = configurable
effective_from = configurable
```

Les taux doivent pouvoir évoluer sans redéploiement de l'interface.

---

# 91. LOCALISATION

V1 :

```text
fr-FR
XOF
Africa/Abidjan
```

Mais architecture prête pour :

```text
en
USD
EUR
GHS
NGN
```

Ne pas écrire en dur dans tout le code :

```text
FCFA
Abidjan
Côte d'Ivoire
```

Utiliser les paramètres de propriété.

---

# 92. NOMENCLATURE DES STATUTS

Utiliser des enums côté domaine/base.

Ne pas utiliser des chaînes arbitraires partout.

Exemple :

```text
ReservationStatus
RoomStatus
StayStatus
PaymentStatus
InvoiceStatus
HousekeepingStatus
MaintenanceStatus
NightAuditStatus
```

---

# 93. TRANSACTIONS

Les opérations suivantes doivent être transactionnelles :

```text
Create Reservation
Check-in
Change Room
Post Charge
Payment
Refund
Finalize Invoice
Checkout
Night Audit
Housekeeping status transition
```

---

# 94. TRANSACTION CHECK-IN

Le check-in doit réaliser dans une transaction :

```text
lock reservation
verify reservation
verify room
verify availability
create stay
assign room
open folio
update reservation
update room
create audit
```

Si une étape échoue :

```text
ROLLBACK
```

---

# 95. TRANSACTION CHECKOUT

Dans une transaction :

```text
lock stay
verify balance
finalize charges
create invoice
update stay
release room
create housekeeping task
create audit
```

La certification FNE elle-même étant externe, ne pas tenir une transaction PostgreSQL ouverte pendant un appel HTTP externe.

Utiliser un pattern outbox/job pour l'intégration externe.

---

# 96. OUTBOX PATTERN

Créer :

## domain_events / outbox_events

```text
id
organization_id
property_id
event_type
aggregate_type
aggregate_id
payload
status
attempts
available_at
processed_at
created_at
```

Lorsqu'une transaction critique se termine :

```text
DB transaction
 ├── modification métier
 └── outbox event
```

Puis un worker :

```text
Outbox
 ↓
Queue
 ↓
Handler
 ↓
Notification / FNE / Report
```

Cela évite de perdre un événement.

---

# 97. FNE OUTBOX

Lorsqu'une facture doit être certifiée :

```text
invoice finalized
        ↓
fne submission event
        ↓
queue
        ↓
FNE adapter
        ↓
response
        ↓
fne_document update
```

Ne jamais bloquer l'intégralité du PMS parce que le fournisseur FNE est indisponible.

Afficher :

```text
FNE_PENDING
```

et permettre le retry.

---

# 98. ENVIRONNEMENTS

Créer :

```text
development
staging
production
```

Variables :

```text
DATABASE_URL
REDIS_URL
JWT_SECRET
SESSION_SECRET
S3_ENDPOINT
S3_BUCKET
S3_ACCESS_KEY
S3_SECRET_KEY
FNE_BASE_URL
FNE_API_KEY
FNE_API_SECRET
EMAIL_PROVIDER
```

Ne jamais mettre les secrets dans Git.

Créer :

```text
.env.example
```

sans secrets réels.

---

# 99. CI/CD

Pipeline :

```text
install
↓
lint
↓
typecheck
↓
unit tests
↓
integration tests
↓
build
↓
security checks
↓
E2E
↓
migration check
↓
deployment
```

Production ne doit être déployée que si les checks critiques passent.

---

# 100. DOCKER

Créer :

```text
web
api
postgres
redis
worker
```

Pour développement.

La production doit pouvoir être déployée derrière un reverse proxy sécurisé.

---

# 101. HEALTH CHECKS

Créer :

```text
/health
/ready
```

Vérifier :

```text
API
Database
Redis
Queue
Storage
```

Ne pas exposer d'informations sensibles.

---

# 102. PERFORMANCE

Objectifs initiaux :

```text
API CRUD standard < 300 ms
dashboard < 2 s avec cache
pages principales < 2 s sur réseau raisonnable
```

Utiliser :

* indexes ;
* pagination ;
* caching ;
* query optimization ;
* select minimal ;
* background jobs.

---

# 103. DATABASE INDEXES

Créer des indexes notamment sur :

```text
reservations(property_id, arrival_date)
reservations(property_id, departure_date)
reservations(property_id, status)
reservation_rooms(room_type_id, arrival_date, departure_date)
rooms(property_id, status)
rooms(property_id, room_type_id)
guests(property_id, phone)
guests(property_id, email)
folios(stay_id)
folio_items(folio_id, business_date)
payments(folio_id)
payments(property_id, paid_at)
invoices(property_id, issued_at)
invoices(property_id, status)
fne_documents(invoice_id)
housekeeping_tasks(property_id, status)
night_audits(property_id, business_date)
audit_logs(property_id, created_at)
```

Analyser les index réels via EXPLAIN lorsque nécessaire.

---

# 104. SOFT DELETE

Utiliser soft delete uniquement sur les données maîtres lorsque pertinent :

```text
guest
company
agency
room
room type
user
```

Ne jamais soft-delete une transaction financière comme moyen de correction.

---

# 105. BUSINESS DATE

Le système doit toujours connaître :

```text
current_business_date
```

par propriété.

Une propriété peut être en :

```text
2026-10-03
```

même si un job technique UTC a déjà changé de date ailleurs.

Le Night Audit contrôle la transition de business date.

---

# 106. DASHBOARD DATA

Ne pas calculer tous les KPI directement à partir de centaines de milliers de lignes à chaque chargement.

Créer des vues ou agrégations lorsque nécessaire.

Commencer avec des queries optimisées puis introduire :

```text
daily_metrics
```

si nécessaire.

Exemple :

## daily_hotel_metrics

```text
id
property_id
business_date
available_rooms
occupied_rooms
out_of_order_rooms
occupancy_rate
room_revenue
other_revenue
gross_revenue
tax_revenue
adr
revpar
payments
outstanding
created_at
updated_at
```

---

# 107. PRINCIPE DE VÉRITÉ DES DONNÉES

Il ne doit exister qu'une source de vérité.

Exemple :

Le dashboard ne doit pas avoir une variable indépendante :

```text
revenue = 150000
```

Le dashboard doit calculer son information depuis :

```text
folio_items
payments
invoices
daily_metrics
```

Le frontend ne possède aucune vérité métier.

---

# 108. PWA / INSTALLATION

Permettre :

```text
Add to Home Screen
```

et utilisation :

```text
Reception PC
Tablet Housekeeping
Mobile Manager
```

Créer des layouts adaptés aux rôles.

---

# 109. ACCESSIBILITÉ

Respecter autant que possible :

```text
WCAG 2.1 AA
```

Prévoir :

* navigation clavier ;
* focus ;
* labels ;
* contraste ;
* aria ;
* erreurs de formulaires compréhensibles.

---

# 110. SYSTÈME DE PERMISSION DE PRIX

Les modifications tarifaires doivent être contrôlées.

Exemple :

```text
RECEPTIONIST
→ prix standard uniquement

FRONT_DESK_MANAGER
→ override jusqu'à X %

GENERAL_MANAGER
→ override sans limite configurée
```

Créer une règle configurable :

```text
rate_override_policy
```

Chaque override doit être audité :

```text
ancien prix
nouveau prix
motif
utilisateur
timestamp
```

---

# 111. DISCOUNTS

Ne jamais faire :

```text
total = total - discount
```

sans traçabilité.

Créer :

```text
discount_type
discount_value
discount_reason
approved_by
```

Le montant final doit rester reconstructible.

---

# 112. WALK-IN

Supporter un client qui arrive sans réservation :

```text
Walk-in
 ↓
Availability
 ↓
Guest creation/search
 ↓
Room selection
 ↓
Rate
 ↓
Payment/deposit
 ↓
Check-in
```

---

# 113. SPLIT FOLIO

Supporter :

```text
Guest
 ├── Room → Company
 ├── Breakfast → Guest
 ├── Restaurant → Guest
 └── Laundry → Company
```

Créer la possibilité de transférer un folio item vers un folio cible avec audit.

---

# 114. COMPANY BILLING

Exemple :

```text
Company = ABC CI

Room → Company
Breakfast → Company
Restaurant → Guest
Bar → Guest
```

La règle de facturation doit être configurable au niveau du séjour/réservation.

---

# 115. PREPAYMENT

Supporter :

```text
Deposit required
Deposit received
Deposit allocated
Deposit refunded
Deposit forfeited
```

Un acompte n'est pas automatiquement un revenu.

Le modèle financier doit le traiter séparément jusqu'à son allocation selon la règle comptable choisie.

---

# 116. OVERPAYMENT

Supporter :

```text
invoice = 100000
payment = 120000
```

Le système doit gérer :

```text
credit balance
```

et ne pas simplement perdre les 20 000 FCFA.

---

# 117. CREDIT LIMIT

Pour les entreprises :

```text
credit_limit
payment_terms
outstanding_balance
```

Une réservation corporate peut être bloquée lorsque la limite de crédit est dépassée selon la politique configurée.

---

# 118. ALERTES

Dashboard :

```text
⚠ 3 folios impayés
⚠ 2 chambres OOO
⚠ 1 facture FNE rejetée
⚠ 4 chambres à inspecter
⚠ 1 caisse avec variance
⚠ 3 réservations non garanties
```

Chaque alerte doit être cliquable et mener à l'action correspondante.

---

# 119. DOCUMENTS CLIENT

Prévoir :

```text
reservation confirmation
invoice
receipt
folio
```

avec téléchargement.

---

# 120. DATA RETENTION

Créer une politique configurable :

```text
retention_policy
```

Les données personnelles ne doivent pas être conservées indéfiniment sans raison.

Prévoir architecture permettant :

```text
archive
anonymization
deletion
legal hold
```

L'effacement ne doit cependant jamais détruire les informations nécessaires à l'intégrité des documents et transactions légalement conservés.

---

# 121. EXTENSIBILITÉ V2

Les interfaces suivantes doivent être prévues mais peuvent rester abstraites :

```text
PaymentProvider
FNEProvider
NotificationProvider
WhatsAppProvider
SMSProvider
ChannelManagerProvider
AccountingProvider
StorageProvider
```

Cela permettra :

```text
Orange Money
MTN MoMo
Moov Money
Wave
banque
Stripe
etc.
```

sans modifier le domaine métier.

Ne pas intégrer de fournisseur de paiement réel dans le V1 tant que les credentials et exigences commerciales ne sont pas disponibles.

---

# 122. FUTUR POS

Le V1 ne doit pas implémenter complètement le POS.

Mais le domaine doit être prévu pour :

```text
POSOrder
POSOrderItem
Outlet
Table
Product
Recipe
StockMovement
```

et surtout :

```text
POS
 ↓
ROOM_CHARGE
 ↓
Folio
```

---

# 123. FUTUR STOCK

Prévoir l'extension :

```text
products
warehouses
stock_movements
suppliers
purchase_orders
goods_receipts
supplier_invoices
```

Mais ne pas ajouter inutilement de complexité au V1.

---

# 124. FUTUR CHANNEL MANAGER

Le PMS doit avoir un champ :

```text
external_reference
```

et une notion :

```text
source/channel
```

permettant plus tard :

```text
Booking
Expedia
Airbnb
Website
```

de créer/modifier des réservations.

Prévoir un `ExternalReservationAdapter`.

---

# 125. FUTUR CRM

Le guest profile du V1 doit déjà permettre :

```text
historique séjours
préférences
entreprise
agence
VIP
consentement marketing
```

afin que le CRM V2 puisse exploiter les données sans migration majeure.

---

# 126. BUSINESS RULES — TAXE NUITÉE

Implémenter la taxe comme une règle configurable avec date d'effet.

Pour le paramétrage ivoirien 2026, les valeurs doivent correspondre aux sources officielles en vigueur au moment du déploiement.

Le moteur doit aussi stocker :

```text
tax jurisdiction
beneficiary
collection period
amount collected
amount due
due date
```

et permettre la génération du reporting de reversement.

Ne jamais supposer que toutes les propriétés ont exactement la même règle de reversement : la localisation territoriale doit être un attribut de configuration.

---

# 127. RÈGLE DE CONFORMITÉ FISCALE

Le logiciel doit pouvoir distinguer :

```text
tax calculated
tax collected
tax declared
tax submitted
tax paid
```

Ces états ne doivent pas être confondus.

---

# 128. ADMINISTRATION

Créer un super-admin système capable de :

```text
create organization
create property
assign administrator
configure subscription
disable property
```

L'administrateur hôtel doit uniquement voir son organisation.

---

# 129. SUBSCRIPTION READY

Même si le V1 ne facture pas encore le SaaS, prévoir :

```text
organization
plan
subscription
subscription_status
trial_ends_at
```

mais ne pas construire tout le billing SaaS inutilement.

---

# 130. DEMO MODE

Prévoir un mode démo totalement isolé des données réelles.

```text
DEMO
TEST
PRODUCTION
```

Aucune donnée de démonstration ne doit apparaître en production.

---

# 131. DOCUMENTATION À PRODUIRE

Le projet doit contenir :

```text
README.md

docs/
├── architecture.md
├── database.md
├── api.md
├── workflows.md
├── security.md
├── deployment.md
├── backup-restore.md
├── fne-integration.md
├── tax-engine.md
├── permissions.md
└── testing.md
```

---

# 132. ERD

Produire un diagramme ERD documentant au minimum :

```text
Organization
Property
Room
RoomType
Guest
Company
Agency
Reservation
ReservationRoom
ReservationGuest
Stay
StayRoom
Folio
FolioItem
Payment
PaymentAllocation
Invoice
InvoiceItem
TaxRule
NightTaxConfiguration
FneDocument
HousekeepingTask
MaintenanceTicket
CashRegister
CashSession
AuditLog
User
Role
Permission
NightAudit
```

---

# 133. ACCEPTANCE CRITERIA V1

Le V1 est considéré terminé uniquement lorsqu'un utilisateur peut effectuer entièrement ce scénario :

```text
1. Créer un hôtel

2. Créer un type de chambre

3. Créer 10 chambres

4. Configurer un tarif

5. Configurer les taxes

6. Créer un client

7. Créer une réservation

8. Confirmer la réservation

9. Attribuer une chambre

10. Faire le check-in

11. Ajouter une prestation

12. Ajouter un paiement

13. Voir le solde

14. Générer la facture

15. Soumettre la facture à l'adapter FNE

16. Effectuer le checkout

17. Générer automatiquement la tâche housekeeping

18. Nettoyer la chambre

19. Inspecter la chambre

20. Rendre la chambre disponible

21. Exécuter le Night Audit

22. Voir les KPI du jour

23. Voir les transactions dans l'audit log.
```

---

# 134. ACCEPTANCE CRITERIA — DOUBLE RÉSERVATION

Test :

```text
1 dernière chambre disponible

User A → réservation
User B → réservation simultanée
```

Résultat :

```text
A = success
B = controlled business error
```

Jamais :

```text
A = success
B = success
```

---

# 135. ACCEPTANCE CRITERIA — PAIEMENT

Test :

```text
invoice = 100000
payment = 100000
```

Résultat :

```text
balance = 0
```

Puis :

```text
même requête envoyée deux fois
```

Résultat :

```text
un seul paiement.
```

---

# 136. ACCEPTANCE CRITERIA — NIGHT AUDIT

Lancer deux fois :

```text
Night Audit
```

Résultat attendu :

```text
pas de double posting
pas de double taxation
pas de double revenue
```

---

# 137. ACCEPTANCE CRITERIA — AUDIT

Modifier :

```text
prix
remise
paiement
chambre
réservation
facture
```

Chaque changement critique doit laisser une trace.

---

# 138. ACCEPTANCE CRITERIA — TENANT ISOLATION

Créer :

```text
Hotel A
Hotel B
```

Créer les mêmes identifiants métier dans les deux.

L'utilisateur de Hotel A ne doit jamais pouvoir voir Hotel B.

Tester cela directement contre l'API en manipulant les IDs.

---

# 139. ACCEPTANCE CRITERIA — FNE

Simuler :

```text
FNE success
FNE timeout
FNE 500
FNE rejection
duplicate request
```

Le système doit :

```text
retry lorsque approprié
ne jamais dupliquer la facture
conserver l'état
conserver le diagnostic
permettre retry manuel autorisé
```

---

# 140. DEFINITION OF DONE

Une fonctionnalité n'est pas considérée terminée tant qu'elle ne possède pas :

```text
UI
API
Validation
Business logic
Database
Transaction handling
Authorization
Audit
Error handling
Tests
Loading state
Empty state
Error state
Success state
Responsive UI
Documentation
```

---

# 141. RÈGLE TRÈS IMPORTANTE POUR L'AGENT DE DÉVELOPPEMENT

Ne pas tout générer en une seule énorme modification aveugle.

Travailler par étapes cohérentes :

```text
PHASE 1
Architecture
Database
Auth
Tenant

PHASE 2
Property
Rooms
Room Types
Rates

PHASE 3
Guests
Reservations
Availability

PHASE 4
Stay
Check-in
Room Changes
Check-out

PHASE 5
Folios
Charges
Payments
Cash

PHASE 6
Invoices
Taxes
FNE adapter

PHASE 7
Housekeeping
Maintenance

PHASE 8
Night Audit
Reports
Dashboard

PHASE 9
Security
Audit
Offline
Performance

PHASE 10
Tests
Deployment
Documentation
```

Après chaque phase :

```text
typecheck
lint
unit tests
integration tests
build
```

et corriger les erreurs avant de continuer.

---

# 142. INTERDICTIONS

Ne pas :

* créer de données fictives dans les services de production ;
* stocker les montants en float ;
* supprimer des transactions financières ;
* faire confiance aux IDs envoyés par le client ;
* coder les permissions uniquement côté frontend ;
* coder les taxes uniquement dans React ;
* appeler directement FNE depuis un composant React ;
* stocker les credentials en Git ;
* utiliser des `any` partout ;
* désactiver TypeScript pour contourner les erreurs ;
* désactiver les tests ;
* utiliser des `TODO` comme remplacement d'une fonctionnalité annoncée comme terminée ;
* créer des microservices prématurément ;
* dupliquer les composants UI existants ;
* modifier complètement le design du template sans nécessité.

---

# 143. PRIORITÉ ABSOLUE

Lorsque tu dois choisir entre :

```text
beautiful UI
```

et :

```text
correct business logic
```

privilégier la logique métier correcte.

Lorsque tu dois choisir entre :

```text
feature supplémentaire
```

et :

```text
data integrity
```

privilégier l'intégrité des données.

Lorsque tu dois choisir entre :

```text
rapid implementation
```

et :

```text
correct transactional behavior
```

privilégier le comportement transactionnel correct.

---

# 144. RÉSULTAT ATTENDU

À la fin du V1, je dois avoir un logiciel capable de piloter le fonctionnement quotidien d'un hôtel depuis :

```text
Réservation
        ↓
Arrivée
        ↓
Check-in
        ↓
Séjour
        ↓
Prestations
        ↓
Folio
        ↓
Paiement
        ↓
Facturation
        ↓
FNE
        ↓
Check-out
        ↓
Housekeeping
        ↓
Night Audit
        ↓
Reporting
```

Le système doit être fiable, traçable, extensible et réellement exploitable en production.

---

# 145. PREMIÈRE ACTION À EFFECTUER

Avant d'écrire du code :

1. Inspecter le projet actuel.
2. Identifier sa stack.
3. Identifier les composants UI existants.
4. Identifier les fonctionnalités déjà présentes.
5. Produire un inventaire du projet.
6. Identifier les éventuelles incompatibilités avec l'architecture cible.
7. Proposer la structure finale.
8. Générer le premier schéma de base de données.
9. Générer les migrations.
10. Mettre en place l'authentification, le tenant context et les permissions.
11. Puis seulement commencer les modules métier.

NE PAS remplacer arbitrairement le template existant.

NE PAS commencer par fabriquer les pages du dashboard.

Commencer par le socle métier et technique.

---

# 146. FORMAT DES RÉPONSES DE L'AGENT

À chaque étape, indiquer :

```text
OBJECTIF

CE QUI EXISTE

CE QUI EST MODIFIÉ

FICHIERS CRÉÉS

FICHIERS MODIFIÉS

MIGRATIONS

RÈGLES MÉTIER

TESTS

RÉSULTAT

PROBLÈMES RESTANTS
```

Ne pas déclarer une fonctionnalité terminée si elle n'est pas réellement testée.

---

# 147. PHILOSOPHIE FINALE

Ce projet n'est pas un template administratif.

C'est un **système transactionnel hôtelier**.

La donnée métier est prioritaire.

Le workflow est prioritaire.

L'intégrité financière est prioritaire.

La traçabilité est prioritaire.

La sécurité est prioritaire.

Le design vient ensuite soutenir ces éléments.

Construire une architecture suffisamment propre pour permettre ensuite :

```text
V1
PMS Core

V2
POS + Stock + Achats

V3
OTA + Channel Manager + Booking Engine

V4
CRM + WhatsApp + Fidélité

V5
Multi-hôtel + BI avancée

V6
Revenue Management + IA
```

Ne jamais construire le V1 d'une manière qui empêche ces évolutions.

Commencer maintenant par l'audit du repository/template existant et la conception du socle.
