# Admin Tenants Test Plan

## Application Overview

The admin tenant endpoint creates new flats and bootstrap invites while protecting that capability with an admin token, so tests cover both access control and the shape of successful provisioning responses.

## Test Scenarios

### 1. Tenant Provisioning API

**Seed:** `tests/fixtures.ts` (flat fixture: provisions a fresh tenant + first user, leaves browser logged out)

#### 1.1. admin-tenants-rejects-missing-token-with-401

**File:** `tests/admin.spec.ts`

**Steps:**
  1. Submit a tenant-provisioning request without an admin token.
    - expect: The response status is 401.

#### 1.2. admin-tenants-rejects-wrong-token-with-401

**File:** `tests/admin.spec.ts`

**Steps:**
  1. Submit a tenant-provisioning request with an incorrect admin token.
    - expect: The response status is 401.

#### 1.3. admin-tenants-returns-a-working-invite-url

**File:** `tests/admin.spec.ts`

**Steps:**
  1. Submit a tenant-provisioning request with the valid admin token.
    - expect: The response is successful.
    - expect: The returned invite URL ends with `/invite/<token>`.
    - expect: The returned flat id is a UUID.
