# NestJS Monolith Backend Implementation Roadmap

## 1. Auth, RBAC & User Management Module

- [ ] 1.0 User Registration (`POST /auth/register`)
  - **Spec**: [1.0 Registration Spec](https://raw.githubusercontent.com/pavel-skripko-innowise/inno-fe-be-a1/main/1.0%20%D0%A0%D0%B5%D0%B3%D0%B8%D1%81%D1%82%D1%80%D0%B0%D1%86%D0%B8%D1%8F.md)
  - Password hashing (Argon2 / bcrypt), email confirmation via OTP/magic link, rate limiting, and HTTP response specs.

- [ ] 1.1 RBAC (Role-Based Access Control) Infrastructure
  - **Spec**: [1.1 RBAC Spec](https://raw.githubusercontent.com/pavel-skripko-innowise/inno-fe-be-a1/main/1.1%20RBAC.md)
  - Policy snapshot, permissions management (`permission@action`), dynamic roles assignment.

- [ ] 1.2 Authentication (`POST /auth/login`, `POST /auth/logout`, `POST /auth/refresh`)
  - **Spec**: [1.2 Auth Spec](https://raw.githubusercontent.com/pavel-skripko-innowise/inno-fe-be-a1/main/1.2%20%D0%90%D1%83%D1%82%D0%B5%D0%BD%D1%82%D0%B8%D1%84%D0%B8%D0%BA%D0%B0%D1%86%D0%B8%D1%8F.md)
  - HttpOnly cookies issuance, JWT claims verification, session management.

- [ ] 1.3 Authorization Guards & Middleware
  - **Spec**: [1.3 Authorization Spec](https://raw.githubusercontent.com/pavel-skripko-innowise/inno-fe-be-a1/main/1.3%20%D0%90%D0%B2%D1%82%D0%BE%D1%80%D0%B8%D0%B7%D0%B0%D1%86%D0%B8%D1%8F.md)
  - AuthGuard, RolesGuard execution order, CSRF validations.

- [ ] 1.4 Get Profile Data (`GET /users/me` & `GET /users/:id`)
  - **Spec**: [1.4 User Profile Spec](https://raw.githubusercontent.com/pavel-skripko-innowise/inno-fe-be-a1/main/1.4%20%D0%9F%D1%80%D0%BE%D1%81%D0%BC%D0%BE%D1%82%D1%80%D0%B0%20%D0%B4%D0%B0%D0%BD%D0%BD%D1%8B%D1%85%20%D0%BF%D0%BE%D0%BB%D1%8C%D0%B7%D0%BE%D0%B2%D0%B0%D1%82%D0%B5%D0%BB%D1%8F.md)

- [ ] 1.5 Update User Profile (`PATCH /users/:id`)
  - **Spec**: [1.5 Update User Spec](https://raw.githubusercontent.com/pavel-skripko-innowise/inno-fe-be-a1/main/1.5%20%D0%98%D0%B7%D0%BC%D0%B5%D0%BD%D0%B5%D0%BD%D0%B8%D0%B5%D0%B4%D0%B0%D0%BD%D0%BD%D1%8B%D1%85%20%D0%BF%D0%BE%D0%BB%D1%8C%D0%B7%D0%BE%D0%B2%D0%B0%D1%82%D0%B5%D0%BB%D1%8F.md)

- [ ] 1.6 Delete User Account (`DELETE /users/:id`)
  - **Spec**: [1.6 Delete User Spec](https://raw.githubusercontent.com/pavel-skripko-innowise/inno-fe-be-a1/main/1.6%20%D0%A3%D0%B4%D0%B0%D0%BB%D0%B5%D0%BD%D0%B8%D0%B5%20%D0%BF%D0%BE%D0%BB%D1%8C%D0%B7%D0%BE%D0%B2%D0%B0%D1%82%D0%B5%D0%BB%D1%8F.md)

- [ ] 1.7 List All Users (`GET /admin/users`)
  - **Spec**: [1.7 List Users Spec](https://raw.githubusercontent.com/pavel-skripko-innowise/inno-fe-be-a1/main/1.7%20%D0%9F%D1%80%D0%BE%D1%81%D0%BC%D0%BE%D1%82%D1%80%20%D0%A1%D0%BF%D0%B8%D1%81%D0%BA%D0%B0%20%D0%B2%D1%81%D0%B5%D1%85%20%D0%BF%D0%BE%D0%BB%D1%8C%D0%B7%D0%BE%D0%B2%D0%B0%D1%82%D0%B5%D0%BB%D0%B5%D0%B9.md)

---

## 2. File Transformation & Storage Engine

- [ ] 2.0 General File Processing Engine
  - **Spec**: [2.0 Transformation General Spec](https://raw.githubusercontent.com/pavel-skripko-innowise/inno-fe-be-a1/main/2.0%20%D0%9E%D0%B1%D1%89%D0%B8%D0%B5%20%D1%82%D1%80%D0%B5%D0%B1%D0%BE%D0%B2%D0%B0%D0%BD%D0%B8%D1%8F%20%D0%BA%D1%82%D1%80%D0%B0%D0%BD%D1%81%D1%84%D0%BE%D1%80%D0%BC%D0%B0%D1%86%D0%B8%D0%B8.md)

- [ ] 2.1 Text Transformation Service
  - **Spec**: [2.1 Text Transformation Spec](https://raw.githubusercontent.com/pavel-skripko-innowise/inno-fe-be-a1/main/2.1%20%D0%A2%D1%80%D0%B0%D0%BD%D1%81%D1%84%D0%BE%D1%80%D0%BC%D0%B0%D1%86%D0%B8%D1%8F%20%D1%82%D0%B5%D0%BA%D1%81%D1%82%D0%BE%D0%B2%D1%8B%D1%85%20%D1%84%D0%BE%D1%80%D0%BC%D0%B0%D1%82%D0%BE%D0%B2.md)

- [ ] 2.2 Image Transformation Service
  - **Spec**: [2.2 Image Transformation Spec](https://raw.githubusercontent.com/pavel-skripko-innowise/inno-fe-be-a1/main/2.2%20%D0%A2%D1%80%D0%B0%D0%BD%D1%81%D1%84%D0%BE%D1%80%D0%BC%D0%B0%D1%86%D0%B8%D1%8F%20%D0%B8%D0%B7%D0%BE%D0%B1%D1%80%D0%B0%D0%B6%D0%B5%D0%BD%D0%B8%D0%B9.md)

- [ ] 2.3 Transformation History Service
  - **Spec**: [2.3 Transformation History Spec](https://raw.githubusercontent.com/pavel-skripko-innowise/inno-fe-be-a1/main/2.3%20%D0%9F%D1%80%D0%BE%D1%81%D0%BC%D0%BE%D1%82%D1%80%D0%B8%D1%81%D1%82%D0%BE%D1%80%D0%B8%D0%B8%20%D1%82%D1%80%D0%B0%D0%BD%D1%81%D1%84%D0%BE%D1%80%D0%BC%D0%B0%D1%86%D0%B8%D0%B9.md)

- [ ] 2.4 Object Storage Integration
  - **Spec**: [2.4 Storage Integration Spec](https://raw.githubusercontent.com/pavel-skripko-innowise/inno-fe-be-a1/main/2.4%20%D0%A1%D0%BE%D1%85%D1%80%D0%B0%D0%BD%D0%B5%D0%BD%D0%B8%D0%B5%20%D1%80%D0%B5%D0%B7%D1%83%D0%BB%D1%8C%D1%82%D0%B0%D1%82%D0%BE%D0%B2.md)
