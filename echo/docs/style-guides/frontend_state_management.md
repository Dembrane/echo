# State Management

![state management](./diagrams/state_management.png)

State management is crucial for modern web applications, ensuring data consistency, improving user experience, and maintaining application performance. This document guides you through selecting the most appropriate state management method for your specific needs.

## How to Use This Document

1. **Identify the Purpose:** Determine why you need to store the data. Is it user-specific settings, sensitive data, or shared state?
2. **Choose the Storage Method:** Based on the purpose, select the most appropriate state management method from the options below.

## State Management Methods

### 1. Server-Side State

- **Purpose:** Synchronize state across multiple users.
- **Storage:** Server/Database via APIs.
- **Library:** [@tanstack/query](https://tanstack.com/query) for easy synchronization on the frontend.
  - _Explanation:_ This library helps manage server state by fetching, caching, and syncing data in your applications.
- **Examples:**
  - Shared resources (e.g., collaborative documents)
  - Real-time data (e.g., chat messages, live updates)
  - User authentication status
- **Security Considerations:** Implement proper authentication and authorization. Use HTTPS for all API communications.

### 2. Client-Side Storage

#### 2.1. Session Storage / Local Storage

- **Purpose:** User-specific settings and non-sensitive data.
- **Storage:** Browser's Session Storage or Local Storage.
- **Examples:**
  - Dark mode preference
  - UI configurations
  - Recently viewed items
- **Details:** Use Session Storage for temporary data that should be cleared when the page session ends. Use Local Storage for persistent data that should remain even after the browser is closed and reopened.
- **Security Considerations:** Never store sensitive information. Data can be accessed by any JavaScript code running on the page.

#### 2.2. In-Memory Storage

- **Purpose:** Sensitive data with expiration.
- **Storage:** Application's memory.
- **Examples:**
  - Access tokens
  - Temporary form data
- **Details:** This method is ideal for temporary data that must be accessed quickly and should not be stored persistently due to security concerns.
- **Security Considerations:** Data is cleared when the page is refreshed or closed. Not persistent across sessions.

#### 2.3. HTTP-Only Cookies

- **Purpose:** Persistent sensitive data.
- **Storage:** HTTP-Only cookies that are not accessible via JavaScript.
- **Examples:**
  - Refresh tokens
  - Session IDs
- **Details:** HTTP-Only cookies enhance security by preventing client-side scripts from accessing sensitive data. They are useful for maintaining authentication states.
- **Security Considerations:** Set the Secure flag to ensure transmission only over HTTPS. Use SameSite attribute to prevent CSRF attacks.

#### 2.4. URL State

- **Purpose:** Shareable application state.
- **Storage:** URL parameters or hash fragments.
- **Examples:**
  - Search queries
  - Filter settings
  - Current page in pagination
- **Details:** URL state allows for bookmarkable and shareable application states. It's useful for preserving user actions across page reloads.
- **Security Considerations:** Avoid storing sensitive information in URLs, as they can be easily shared or logged.

#### 2.5. Client-Side State Management Libraries

- **Purpose:** Managing complex application state. (only COMPLEX and which can't otherwise be managed by other methods)
- **Libraries:** Redux, MobX, Recoil
- **Examples:**
  - User interface state
  - Application-wide settings
  - Complex form state
- **Details:** These libraries provide structured ways to manage state in large applications, offering features like time-travel debugging and centralized state management.
- **Security Considerations:** Avoid storing sensitive data in these stores, as they are typically accessible throughout the application.

## Comparison Table

| Method            | Persistence | Security | Shareability | Use Case                   |
| ----------------- | ----------- | -------- | ------------ | -------------------------- |
| Server-Side       | High        | High     | High         | Shared, sensitive data     |
| Local Storage     | High        | Low      | Low          | User preferences           |
| Session Storage   | Medium      | Low      | Low          | Temporary user data        |
| In-Memory         | Low         | Medium   | Low          | Short-lived sensitive data |
| HTTP-Only Cookies | High        | High     | Low          | Authentication tokens      |
| URL State         | Low         | Low      | High         | Shareable app state        |
| State Libraries   | Low-Medium  | Low      | Low          | Complex app state          |

Choosing the right state management method is crucial for building robust and secure web applications. Consider the nature of the data, security requirements, and user experience when making your decision.
