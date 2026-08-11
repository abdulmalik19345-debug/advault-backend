/* AdVault Spy — Landing page interactions (vanilla JS, no dependencies) */
(function () {
  "use strict";

  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ============================================================
     UTIL HELPERS
     ============================================================ */
  function normalizeEmail(value) {
    if (typeof value !== "string") return null;
    var email = value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
    return email;
  }

  function friendlyStatus(status) {
    var s = String(status || "NONE").trim().toUpperCase();
    switch (s) {
      case "ACTIVE": return "Active";
      case "PENDING": return "Pending";
      case "CANCELED": case "CANCELLED": return "Canceled";
      case "PAST_DUE": return "Past due";
      case "TRIALING": return "Trial";
      default: return "None";
    }
  }

  function planLabel(plan) {
    var p = String(plan || "FREE").trim().toUpperCase();
    if (p === "PRO") return "Pro";
    if (p === "AGENCY") return "Agency";
    return "Free";
  }

  function planBadgeClass(plan) {
    var p = String(plan || "FREE").trim().toUpperCase();
    if (p === "PRO") return "plan-badge-pro";
    if (p === "AGENCY") return "plan-badge-agency";
    return "plan-badge-free";
  }

  function formatDate(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function isFreePlan(plan) {
    return String(plan || "FREE").trim().toUpperCase() === "FREE";
  }

  /* ---------- Toast ---------- */
  var toastEl = document.getElementById("toast");
  var toastTimer = null;

  function showToast(message, type) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.classList.remove("toast-error");
    if (type === "error") toastEl.classList.add("toast-error");
    toastEl.classList.add("show");
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      toastEl.classList.remove("show");
    }, 4200);
  }

  /* ============================================================
     API + AUTH STATE
     ============================================================
     The backend owns identity, plan, entitlement and usage. The
     frontend only stores the opaque bearer token and never asserts
     a plan/subscription. All account data (including plan) comes
     from GET /auth/me.
     ============================================================ */

  var configuredApiBase = document.documentElement.getAttribute("data-api-base") || "";
  var originApiBase = /^https?:\/\//i.test(window.location.origin || "") ? window.location.origin : "http://localhost:3000";
  var apiBase = (configuredApiBase || originApiBase).replace(/\/+$/, "");
  var AUTH_TOKEN_KEY = "advault.spy.auth.token";

  var authToken = null;
  var currentUser = null;      // { id, email, plan, subscriptionStatus, ... }
  var currentEntitlement = null;
  var currentUsage = null;

  function apiRequest(path, options) {
    options = options || {};
    var headers = Object.assign(
      { "Content-Type": "application/json" },
      options.headers || {}
    );
    if (authToken) headers["Authorization"] = "Bearer " + authToken;

    return fetch(apiBase + path, {
      method: options.method || "GET",
      headers: headers,
      body: options.body != null ? JSON.stringify(options.body) : undefined,
      credentials: "same-origin",
    }).then(function (res) {
      return res.json().catch(function () {
        return { error: "Unexpected server response." };
      }).then(function (data) {
        return { ok: res.ok, status: res.status, data: data };
      });
    });
  }

  /* ---------- Friendly error mapping ----------
     Never show raw server errors to users. Map status codes to
     clear, human-friendly messages. */
  function friendlyApiError(status, serverError) {
    if (status === 0) return "Unable to connect to AdVault right now. Please try again.";
    if (status >= 500) return "Something went wrong on our end. Please try again in a moment.";
    if (status === 401) {
      if (serverError && /password/i.test(serverError)) return "Invalid email or password.";
      if (serverError && /session|expired/i.test(serverError)) return "Your session has expired. Please log in again.";
      return "Invalid email or password.";
    }
    if (status === 409) return "An account with this email already exists.";
    if (status === 429) return "Too many attempts. Please try again later.";
    if (status === 400) return serverError || "Please check your details and try again.";
    return serverError || "Something went wrong. Please try again.";
  }

  /* ============================================================
     DOM REFERENCES
     ============================================================ */
  var nav = document.getElementById("nav");
  var navLinks = document.getElementById("navLinks");
  var navToggle = document.getElementById("navToggle");
  var navAuthOut = document.getElementById("navAuthOut");
  var navAuthIn = document.getElementById("navAuthIn");

  // Account dropdown
  var accountWrap = document.getElementById("accountWrap");
  var accountChip = document.getElementById("accountChip");
  var accountDropdown = document.getElementById("accountDropdown");
  var navAccountAvatar = document.getElementById("navAccountAvatar");
  var navAccountName = document.getElementById("navAccountName");
  var ddEmail = document.getElementById("ddEmail");
  var ddPlanBadge = document.getElementById("ddPlanBadge");
  var ddUsageToday = document.getElementById("ddUsageToday");
  var ddRemaining = document.getElementById("ddRemaining");
  var ddUpgrade = document.getElementById("ddUpgrade");
  var ddManage = document.getElementById("ddManage");
  var ddLogout = document.getElementById("ddLogout");

  // Auth modal
  var authModal = document.getElementById("authModal");
  var authModalClose = document.getElementById("authModalClose");
  var authTabLogin = document.getElementById("authTabLogin");
  var authTabRegister = document.getElementById("authTabRegister");
  var loginForm = document.getElementById("loginForm");
  var registerForm = document.getElementById("registerForm");
  var resetPasswordModal = document.getElementById("resetPasswordModal");
  var resetPasswordModalClose = document.getElementById("resetPasswordModalClose");
  var forgotPasswordForm = document.getElementById("forgotPasswordForm");
  var resetPasswordForm = document.getElementById("resetPasswordForm");
  var forgotEmailInput = document.getElementById("forgotEmail");
  var forgotSubmit = document.getElementById("forgotSubmit");
  var resetPasswordInput = document.getElementById("resetPassword");
  var resetConfirmInput = document.getElementById("resetConfirm");
  var resetSubmit = document.getElementById("resetSubmit");
  var passwordResetToken = null;

  // Account modal (kept for Manage Account detail view)
  var accountModal = document.getElementById("accountModal");
  var accountModalClose = document.getElementById("accountModalClose");
  var accountEmail = document.getElementById("accountEmail");
  var accountPlanBadge = document.getElementById("accountPlanBadge");
  var accountAvatar = document.getElementById("accountAvatar");
  var accountPlan = document.getElementById("accountPlan");
  var accountSubscription = document.getElementById("accountSubscription");
  var accountUsage = document.getElementById("accountUsage");
  var accountReset = document.getElementById("accountReset");
  var accountCreated = document.getElementById("accountCreated");
  var accountUpgrade = document.getElementById("accountUpgrade");
  var accountLogout = document.getElementById("accountLogout");

  // Verification modal
  var verificationModal = document.getElementById("verificationModal");
  var verificationContent = document.getElementById("verificationContent");
  var verificationSuccess = document.getElementById("verificationSuccess");
  var verificationEmail = document.getElementById("verificationEmail");
  var resendVerificationBtn = document.getElementById("resendVerificationBtn");
  var changeEmailBtn = document.getElementById("changeEmailBtn");
  var verificationLoginBtn = document.getElementById("verificationLoginBtn");
  var loginResendVerification = document.getElementById("loginResendVerification");

  var lastFocused = null;

  /* ---------- Form field helpers ---------- */
  function getGroup(input) {
    return input ? input.closest(".form-group") : null;
  }

  function setFieldError(input, message) {
    var group = getGroup(input);
    if (!group) return;
    var err = group.querySelector(".form-error");
    if (err) {
      err.textContent = message || "";
      err.classList.toggle("is-visible", !!message);
    }
    if (input) {
      if (message) input.setAttribute("aria-invalid", "true");
      else input.removeAttribute("aria-invalid");
    }
  }

  function clearFormErrors(form) {
    if (!form) return;
    form.querySelectorAll(".form-error").forEach(function (el) {
      el.textContent = "";
      el.classList.remove("is-visible");
    });
    form.querySelectorAll("[aria-invalid]").forEach(function (el) {
      el.removeAttribute("aria-invalid");
    });
  }

  /* ============================================================
     ACCOUNT DROPDOWN
     ============================================================ */
  function closeAccountDropdown() {
    if (!accountDropdown) return;
    accountDropdown.classList.add("is-hidden");
    if (accountChip) accountChip.setAttribute("aria-expanded", "false");
  }

  function openAccountDropdown() {
    if (!accountDropdown) return;
    renderAccountDropdown();
    accountDropdown.classList.remove("is-hidden");
    if (accountChip) accountChip.setAttribute("aria-expanded", "true");
  }

  function toggleAccountDropdown() {
    if (accountDropdown && accountDropdown.classList.contains("is-hidden")) {
      openAccountDropdown();
    } else {
      closeAccountDropdown();
    }
  }

  function renderAccountDropdown() {
    if (!currentUser) return;

    var email = currentUser.email || "";
    var plan = currentUser.plan || "FREE";

    if (navAccountAvatar) navAccountAvatar.textContent = (email.charAt(0) || "A").toUpperCase();
    if (navAccountName) navAccountName.textContent = email.split("@")[0] || "Account";
    if (ddEmail) ddEmail.textContent = email;
    if (ddPlanBadge) {
      ddPlanBadge.textContent = planLabel(plan) + " plan";
      ddPlanBadge.className = "plan-badge " + planBadgeClass(plan);
    }

    // Usage today
    if (ddUsageToday) {
      if (currentUsage && currentUsage.unlimited) {
        ddUsageToday.textContent = "Unlimited";
      } else if (currentUsage) {
        ddUsageToday.textContent = (currentUsage.used || 0) + " / " + (currentUsage.limit || 0);
      } else {
        ddUsageToday.textContent = "—";
      }
    }

    // Remaining scans
    if (ddRemaining) {
      if (currentUsage && currentUsage.unlimited) {
        ddRemaining.textContent = "Unlimited";
      } else if (currentUsage && typeof currentUsage.remaining === "number") {
        ddRemaining.textContent = currentUsage.remaining + " left";
      } else if (currentUsage) {
        ddRemaining.textContent = Math.max(0, (currentUsage.limit || 0) - (currentUsage.used || 0)) + " left";
      } else {
        ddRemaining.textContent = "—";
      }
    }

    // Upgrade only for FREE
    if (ddUpgrade) ddUpgrade.classList.toggle("is-hidden", !isFreePlan(plan));
  }

  /* ============================================================
     MODAL MANAGEMENT
     ============================================================ */
  function openModal(modal) {
    if (!modal) return;
    lastFocused = document.activeElement;
    modal.classList.remove("is-hidden");
    document.body.style.overflow = "hidden";
    var focusable = modal.querySelector("input, button, [href]");
    if (focusable) focusable.focus();
  }

  function closeModal(modal) {
    if (!modal) return;
    modal.classList.add("is-hidden");
    var anyOpen =
      (authModal && !authModal.classList.contains("is-hidden")) ||
      (accountModal && !accountModal.classList.contains("is-hidden"));
    if (!anyOpen) document.body.style.overflow = "";
    if (lastFocused && document.contains(lastFocused)) lastFocused.focus();
  }

  function closeAllModals() {
    if (authModal) authModal.classList.add("is-hidden");
    if (accountModal) accountModal.classList.add("is-hidden");
    document.body.style.overflow = "";
    if (lastFocused && document.contains(lastFocused)) lastFocused.focus();
  }

  /* ---------- Auth UI mode ---------- */
  function showLoginForm() {
    if (loginForm) loginForm.classList.remove("is-hidden");
    if (registerForm) registerForm.classList.add("is-hidden");
    if (authTabLogin) { authTabLogin.classList.add("is-active"); authTabLogin.setAttribute("aria-selected", "true"); }
    if (authTabRegister) { authTabRegister.classList.remove("is-active"); authTabRegister.setAttribute("aria-selected", "false"); }
    clearFormErrors(loginForm);
    clearFormErrors(registerForm);
  }

  function showRegisterForm() {
    if (registerForm) registerForm.classList.remove("is-hidden");
    if (loginForm) loginForm.classList.add("is-hidden");
    if (authTabRegister) { authTabRegister.classList.add("is-active"); authTabRegister.setAttribute("aria-selected", "true"); }
    if (authTabLogin) { authTabLogin.classList.remove("is-active"); authTabLogin.setAttribute("aria-selected", "false"); }
    clearFormErrors(loginForm);
    clearFormErrors(registerForm);
  }

  function openAuthModal(mode) {
    closeAccountDropdown();
    if (mode === "register") showRegisterForm();
    else showLoginForm();
    openModal(authModal);
  }

  function openAccountModal() {
    renderAccountModal();
    openModal(accountModal);
  }

  function openVerificationModal(email) {
    closeAllModals();
    if (verificationEmail) verificationEmail.textContent = email;
    if (verificationContent) verificationContent.classList.remove("is-hidden");
    if (verificationSuccess) verificationSuccess.classList.add("is-hidden");
    openModal(verificationModal);
  }

  function showVerificationSuccess() {
    if (verificationContent) verificationContent.classList.add("is-hidden");
    if (verificationSuccess) verificationSuccess.classList.remove("is-hidden");
  }

  function closeVerificationModal() {
    if (verificationModal) closeModal(verificationModal);
  }

  /* ============================================================
     RENDERING
     ============================================================ */
  function renderAuthState() {
    var isAuthed = !!currentUser;

    if (navAuthOut) navAuthOut.classList.toggle("is-hidden", isAuthed);
    if (navAuthIn) navAuthIn.classList.toggle("is-hidden", !isAuthed);
    if (accountDropdown) accountDropdown.classList.add("is-hidden");
    if (accountChip) accountChip.setAttribute("aria-expanded", "false");

    // Update chip first name when authed
    if (isAuthed && navAccountName) {
      var email = currentUser.email || "";
      navAccountName.textContent = email.split("@")[0] || "Account";
      if (navAccountAvatar) navAccountAvatar.textContent = (email.charAt(0) || "A").toUpperCase();
    }
  }

  function renderAccountModal() {
    if (!currentUser) return;

    var email = currentUser.email || "";
    var plan = currentUser.plan || "FREE";

    if (accountEmail) accountEmail.textContent = email;
    if (accountAvatar) accountAvatar.textContent = (email.charAt(0) || "A").toUpperCase();
    if (accountPlanBadge) {
      accountPlanBadge.textContent = planLabel(plan) + " plan";
      accountPlanBadge.className = "plan-badge " + planBadgeClass(plan);
    }
    if (accountPlan) accountPlan.textContent = planLabel(plan);
    if (accountSubscription) accountSubscription.textContent = friendlyStatus(currentUser.subscriptionStatus);

    if (accountUsage) {
      if (currentUsage && currentUsage.unlimited) {
        accountUsage.textContent = "Unlimited";
      } else if (currentUsage) {
        accountUsage.textContent = (currentUsage.used || 0) + " / " + (currentUsage.limit || 0);
      } else {
        accountUsage.textContent = "—";
      }
    }

    if (accountReset) {
      if (currentUsage && currentUsage.resetDate) {
        accountReset.textContent = formatDate(currentUsage.resetDate + "T00:00:00");
      } else if (currentUsage && currentUsage.unlimited) {
        accountReset.textContent = "—";
      } else {
        accountReset.textContent = "—";
      }
    }

    if (accountCreated) accountCreated.textContent = formatDate(currentUser.createdAt);

    if (accountUpgrade) {
      accountUpgrade.classList.toggle("is-hidden", !isFreePlan(plan));
    }
  }

  function applySession(data) {
    currentUser = data.user || null;
    currentEntitlement = data.entitlement || null;
    currentUsage = data.usage || null;
    renderAuthState();
  }

  function clearSession() {
    authToken = null;
    currentUser = null;
    currentEntitlement = null;
    currentUsage = null;
    try { localStorage.removeItem(AUTH_TOKEN_KEY); } catch (e) { /* ignore */ }
    closeAccountDropdown();
    renderAuthState();
  }

  /* ============================================================
     AUTH ACTIONS
     ============================================================ */
  function setLoading(btn, loading) {
    if (!btn) return;
    btn.classList.toggle("loading", loading);
    btn.disabled = loading;
  }

  function handleLogin(e) {
    if (e) e.preventDefault();
    var emailInput = document.getElementById("loginEmail");
    var passInput = document.getElementById("loginPassword");
    var submitBtn = document.getElementById("loginSubmit");
    var resendLink = document.getElementById("loginResendVerification");

    clearFormErrors(loginForm);

    var email = normalizeEmail(emailInput && emailInput.value);
    var password = passInput ? passInput.value : "";

    var valid = true;
    if (!email) {
      setFieldError(emailInput, "Please enter a valid email address.");
      valid = false;
    }
    if (!password) {
      setFieldError(passInput, "Please enter your password.");
      valid = false;
    }
    if (!valid) return;

    setLoading(submitBtn, true);
    apiRequest("/auth/login", {
      method: "POST",
      body: { email: email, password: password },
    })
      .then(function (res) {
        if (res.ok && res.data && res.data.token) {
          authToken = res.data.token;
          try { localStorage.setItem(AUTH_TOKEN_KEY, authToken); } catch (storeErr) { /* ignore */ }
          applySession(res.data);
          closeAllModals();
          showToast("Welcome back, " + (res.data.user && res.data.user.email ? res.data.user.email.split("@")[0] : "") + "!");
          if (resendLink) resendLink.classList.add("is-hidden");
        } else {
          var msg = friendlyApiError(res.status, res.data && res.data.error);
          if (res.status === 403 && res.data && res.data.error === "EMAIL_NOT_VERIFIED") {
            setFieldError(emailInput, "Please verify your email before signing in.");
            if (resendLink) {
              resendLink.classList.remove("is-hidden");
              // Store email for resend action
              resendLink.setAttribute("data-email", email);
            }
          } else if (res.status === 401) {
            setFieldError(emailInput, "Invalid email or password.");
            if (resendLink) resendLink.classList.add("is-hidden");
          } else if (res.status === 429) {
            setFieldError(passInput, msg);
            if (resendLink) resendLink.classList.add("is-hidden");
          } else {
            showToast(msg, "error");
            if (resendLink) resendLink.classList.add("is-hidden");
          }
        }
      })
      .catch(function () {
        showToast("Unable to connect to AdVault right now. Please try again.", "error");
        if (resendLink) resendLink.classList.add("is-hidden");
      })
      .finally(function () {
        setLoading(submitBtn, false);
      });
  }

  function handleRegister(e) {
    if (e) e.preventDefault();
    var emailInput = document.getElementById("registerEmail");
    var passInput = document.getElementById("registerPassword");
    var confirmInput = document.getElementById("registerConfirm");
    var submitBtn = document.getElementById("registerSubmit");

    clearFormErrors(registerForm);

    var email = normalizeEmail(emailInput && emailInput.value);
    var password = passInput ? passInput.value : "";
    var confirm = confirmInput ? confirmInput.value : "";

    var valid = true;
    if (!email) {
      setFieldError(emailInput, "Please enter a valid email address.");
      valid = false;
    }
    if (!password) {
      setFieldError(passInput, "Please enter a password.");
      valid = false;
    } else if (password.length < 8) {
      setFieldError(passInput, "Password must be at least 8 characters.");
      valid = false;
    }
    if (confirm !== password) {
      setFieldError(confirmInput, "Passwords do not match.");
      valid = false;
    }
    if (!valid) return;

    setLoading(submitBtn, true);
    apiRequest("/auth/register", {
      method: "POST",
      body: { email: email, password: password },
    })
      .then(function (res) {
        if (res.ok && res.data && res.data.requiresEmailVerification) {
          // Registration successful, verification required
          closeAllModals();
          openVerificationModal(res.data.user && res.data.user.email ? res.data.user.email : email);
          showToast("Account created! Check your email to verify your address.");
        } else {
          var msg = friendlyApiError(res.status, res.data && res.data.error);
          if (res.status === 409) setFieldError(emailInput, "An account with this email already exists. Please log in instead.");
          else if (res.status === 400) setFieldError(passInput, msg);
          else showToast(msg, "error");
        }
      })
      .catch(function () {
        showToast("Unable to connect to AdVault right now. Please try again.", "error");
      })
      .finally(function () {
        setLoading(submitBtn, false);
      });
  }

  function handleLogout(e) {
    if (e) e.preventDefault();
    var token = authToken;
    if (token) {
      apiRequest("/auth/logout", { method: "POST" }).catch(function () { /* ignore */ });
    }
    clearSession();
    closeNav();
    closeAllModals();
    showToast("You've been logged out.");
  }

  function openForgotPasswordModal(email) {
    closeAllModals();
    if (!resetPasswordModal) return;
    if (forgotPasswordForm) forgotPasswordForm.classList.remove("is-hidden");
    if (resetPasswordForm) resetPasswordForm.classList.add("is-hidden");
    if (forgotEmailInput && email) forgotEmailInput.value = email;
    clearFormErrors(forgotPasswordForm);
    resetPasswordModal.classList.remove("is-hidden");
    if (forgotEmailInput) window.setTimeout(function () { forgotEmailInput.focus(); }, 0);
  }

  function openResetPasswordModal(token) {
    closeAllModals();
    if (!resetPasswordModal) return;
    passwordResetToken = token;
    if (forgotPasswordForm) forgotPasswordForm.classList.add("is-hidden");
    if (resetPasswordForm) resetPasswordForm.classList.remove("is-hidden");
    clearFormErrors(resetPasswordForm);
    resetPasswordModal.classList.remove("is-hidden");
    if (resetPasswordInput) window.setTimeout(function () { resetPasswordInput.focus(); }, 0);
  }

  function handleForgotPassword(e) {
  if (e) e.preventDefault();

  var emailInput = document.getElementById("loginEmail");
  var email = normalizeEmail(emailInput && emailInput.value);

  if (!email) {
    setFieldError(emailInput, "Enter your email address first.");
    if (emailInput) emailInput.focus();
    return;
  }

  setFieldError(emailInput, "");

  apiRequest("/auth/forgot-password", {
    method: "POST",
    body: { email: email },
  })
    .then(function (res) {
      if (res.ok) {
        showToast(
          "If an account exists for this email, password reset instructions have been sent."
        );
      } else {
        var msg = friendlyApiError(
          res.status,
          res.data && (res.data.message || res.data.error)
        );
        showToast(msg, "error");
      }
    })
    .catch(function (err) {
      console.error("[AdVault Spy] Forgot password request failed:", err);
      showToast(
        "Unable to connect to AdVault right now. Please try again.",
        "error"
      );
    });
}

  function handleForgotPasswordSubmit(e) {
    if (e) e.preventDefault();
    clearFormErrors(forgotPasswordForm);
    var email = normalizeEmail(forgotEmailInput && forgotEmailInput.value);
    if (!email) {
      setFieldError(forgotEmailInput, "Please enter a valid email address.");
      return;
    }
    setLoading(forgotSubmit, true);
    apiRequest("/auth/forgot-password", { method: "POST", body: { email: email } })
      .then(function (res) {
        if (res.ok) {
          showToast("If an account exists for that email, a reset link has been sent.");
          closeModal(resetPasswordModal);
        } else {
          showToast(friendlyApiError(res.status, res.data && (res.data.message || res.data.error)), "error");
        }
      })
      .catch(function () {
        showToast("Unable to connect to AdVault right now. Please try again.", "error");
      })
      .finally(function () { setLoading(forgotSubmit, false); });
  }

  function handleResetPasswordSubmit(e) {
    if (e) e.preventDefault();
    clearFormErrors(resetPasswordForm);
    var password = resetPasswordInput ? resetPasswordInput.value : "";
    var confirm = resetConfirmInput ? resetConfirmInput.value : "";
    var valid = true;
    if (!password || password.length < 8) {
      setFieldError(resetPasswordInput, "Password must be at least 8 characters.");
      valid = false;
    }
    if (confirm !== password) {
      setFieldError(resetConfirmInput, "Passwords do not match.");
      valid = false;
    }
    if (!passwordResetToken) {
      showToast("This password reset link is missing or invalid. Please request a new one.", "error");
      return;
    }
    if (!valid) return;

    setLoading(resetSubmit, true);
    apiRequest("/auth/reset-password", {
      method: "POST",
      body: { token: passwordResetToken, password: password },
    })
      .then(function (res) {
        if (res.ok) {
          passwordResetToken = null;
          var url = new URL(window.location.href);
          url.searchParams.delete("reset_token");
          window.history.replaceState({}, "", url.pathname + url.search + url.hash);
          closeModal(resetPasswordModal);
          openAuthModal("login");
          showToast("Password reset successfully. You can now log in.");
        } else {
          showToast(friendlyApiError(res.status, res.data && (res.data.message || res.data.error)), "error");
        }
      })
      .catch(function () {
        showToast("Unable to connect to AdVault right now. Please try again.", "error");
      })
      .finally(function () { setLoading(resetSubmit, false); });
  }

  function handleResendVerification(e) {
    if (e) e.preventDefault();
    var email = this.getAttribute("data-email") || 
                (verificationEmail ? verificationEmail.textContent : "") ||
                (document.getElementById("loginEmail") ? document.getElementById("loginEmail").value : "");
    email = normalizeEmail(email);
    if (!email) {
      showToast("Unable to determine email address. Please try again.", "error");
      return;
    }

    var btn = this;
    var originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Sending...";

    apiRequest("/auth/resend-verification", {
      method: "POST",
      body: { email: email },
    })
      .then(function (res) {
        if (res.ok) {
          showToast("Verification email sent! Check your inbox.");
        } else {
          var msg = friendlyApiError(res.status, res.data && res.data.error);
          showToast(msg, "error");
        }
      })
      .catch(function () {
        showToast("Unable to connect to AdVault right now. Please try again.", "error");
      })
      .finally(function () {
        btn.disabled = false;
        btn.textContent = originalText;
      });
  }

  function handleVerificationSuccess(e) {
    if (e) e.preventDefault();
    closeVerificationModal();
    openAuthModal("login");
  }

  /* ============================================================
       EXTENSION ACTION
       ============================================================ */
  function handleOpenExtension(e) {
    if (e) e.preventDefault();

    // Debug: confirm the click handler is actually firing during development.
    console.log("[AdVault Spy landing] Open Extension handler fired.");

    closeAccountDropdown();
    closeNav();

    // Try to open the extension's own popup/extension page.
    //
    // This is an unpacked (development) extension and its ID is not known at
    // build time, so we cannot construct a chrome-extension:// URL. We only
    // open the extension page when we are actually running inside the
    // extension context (chrome.runtime.id is present). From a normal web
    // page (which is how the landing page is served) that is not possible,
    // and we DO NOT invent a fake URL or redirect to the landing page.

    // 1) Inside the extension's own context (popup/options page).
    if (window.chrome && chrome.runtime && chrome.runtime.id) {
      try {
        console.log("[AdVault Spy landing] Opening extension page (inside extension context).");
        var url = chrome.runtime.getURL("popup.html");
        if (url) {
          if (typeof chrome.tabs !== "undefined" && chrome.tabs.create) {
            chrome.tabs.create({ url: url });
          } else {
            window.open(url, "_blank");
          }
          showToast("Opening AdVault Spy\u2026");
          return;
        }
      } catch (err) {
        console.warn("[AdVault Spy landing] Could not open extension page:", err);
      }
    }

    // 2) Attempt to reach an installed extension via the messaging bridge.
    //    This only works if the extension declares an externally_connectable
    //    match for this page. If it is not installed, lastError is set.
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
      try {
        chrome.runtime.sendMessage(
          { type: "OPEN_ADVAULT" },
          function () {
            if (chrome.runtime.lastError) {
              showToast("AdVault Spy isn't available here. Make sure the extension is installed in Chrome.", "error");
            } else {
              showToast("Opening AdVault Spy\u2026");
            }
          }
        );
        return;
      } catch (err) {
        console.warn("[AdVault Spy landing] Extension messaging bridge unavailable:", err);
      }
    }

    // 3) Extension is not reachable from this page. Show a clear, useful
    //    message instead of silently doing nothing.
    console.log("[AdVault Spy landing] Extension not available on this page.");
    showToast("AdVault Spy isn't available here. Make sure the extension is installed in Chrome.", "error");
  }

  /* ============================================================
     PRICING ACTIONS
     ============================================================ */
  // PayPal checkout is not connected yet. This function is structured so the
  // real PayPal endpoint can be wired in without redesigning the UI:
  //   apiRequest("/paypal/create-checkout", { method: "POST", body: { plan } })
  //     .then(function (res) { if (res.ok && res.data.url) window.location.href = res.data.url; })
  function handlePricing(plan, e) {
    if (e) e.preventDefault();
    closeNav();

    if (plan === "free") {
      if (!currentUser) {
        openAuthModal("register");
      } else {
        showToast("You're on the Free plan — 2 scans per day.");
        openAccountModal();
      }
      return;
    }

    // Pro / Agency require a logged-in user first.
    if (!currentUser) {
      showToast("Please log in first to upgrade your plan.");
      openAuthModal("login");
      return;
    }

    // Already on this (or higher) plan? No checkout needed.
    var currentPlan = String(currentUser.plan || "FREE").trim().toUpperCase();
    if (plan === "pro" && (currentPlan === "PRO" || currentPlan === "AGENCY")) {
      showToast("You're already on a paid plan.");
      openAccountModal();
      return;
    }
    if (plan === "agency" && currentPlan === "AGENCY") {
      showToast("You're already on the Agency plan.");
      openAccountModal();
      return;
    }

    // PayPal endpoints are not implemented yet. Report clearly; structure the
    // frontend so a real endpoint can be connected without a redesign.
    showToast("PayPal checkout is not connected yet.", "error");
  }

  /* ============================================================
     NAVBAR / SMOOTH SCROLL
     ============================================================ */
  function closeNav() {
    if (!navLinks) return;
    navLinks.classList.remove("open");
    if (navToggle) {
      navToggle.classList.remove("open");
      navToggle.setAttribute("aria-expanded", "false");
    }
  }

  function smoothScroll(target) {
    var el = document.querySelector(target);
    if (!el) return;
    if (reducedMotion) {
      el.scrollIntoView();
      return;
    }
    var headerOffset = 84;
    var top = el.getBoundingClientRect().top + window.pageYOffset - headerOffset;
    window.scrollTo({ top: top, behavior: "smooth" });
  }

  function updateNavState() {
    if (nav) nav.classList.toggle("scrolled", window.scrollY > 12);
  }

  /* ============================================================
     EVENT WIRING
     ============================================================ */
  // Mobile nav toggle
  if (navToggle && navLinks) {
    navToggle.addEventListener("click", function () {
      var open = navLinks.classList.toggle("open");
      navToggle.classList.toggle("open", open);
      navToggle.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) closeAccountDropdown();
    });
  }

  // Close nav on link click
  if (navLinks) {
    navLinks.addEventListener("click", function (e) {
      if (e.target && e.target.tagName === "A") closeNav();
    });
  }

  // Close nav clicking outside
  document.addEventListener("click", function (e) {
    if (navLinks && navLinks.classList.contains("open") && !navLinks.contains(e.target) && navToggle && !navToggle.contains(e.target)) {
      closeNav();
    }
  });

  // Smooth scroll for in-page anchors
  document.querySelectorAll('a[href^="#"]').forEach(function (link) {
    link.addEventListener("click", function (e) {
      var href = link.getAttribute("href");
      if (href.length < 2) return;
      var targetEl = document.querySelector(href);
      if (!targetEl) return;
      e.preventDefault();
      closeNav();
      smoothScroll(href);
    });
  });

  // Navbar scroll state
  window.addEventListener("scroll", updateNavState, { passive: true });
  updateNavState();

  // Password reset links arrive at /?reset_token=... from the email.
  (function handlePasswordResetLink() {
    try {
      var params = new URLSearchParams(window.location.search);
      var token = params.get("reset_token");
      if (token) openResetPasswordModal(token);
    } catch (err) { /* ignore malformed URLs */ }
  })();

  // Reveal animations
  var revealEls = document.querySelectorAll(".reveal");
  if (!reducedMotion && "IntersectionObserver" in window) {
    var revealObserver = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("visible");
            revealObserver.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
    );
    revealEls.forEach(function (el) { revealObserver.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add("visible"); });
  }

  // FAQ accordion (single open at a time)
  var faqItems = document.querySelectorAll(".faq-item");
  faqItems.forEach(function (item) {
    var summary = item.querySelector("summary");
    if (!summary) return;
    summary.addEventListener("click", function (e) {
      e.preventDefault();
      var willOpen = !item.open;
      faqItems.forEach(function (other) {
        if (other !== item) other.open = false;
      });
      item.open = willOpen;
    });
  });

  // data-auth actions
  document.querySelectorAll("[data-auth]").forEach(function (el) {
    el.addEventListener("click", function (e) {
      e.preventDefault();
      closeNav();
      var action = el.getAttribute("data-auth");
      if (action === "login") openAuthModal("login");
      else if (action === "register") openAuthModal("register");
      else if (action === "account") openAccountModal();
      else if (action === "logout") handleLogout(e);
      else if (action === "forgot") handleForgotPassword(e);
    });
  });

  // data-auth-switch (login <-> register)
  document.querySelectorAll("[data-auth-switch]").forEach(function (el) {
    el.addEventListener("click", function (e) {
      e.preventDefault();
      var mode = el.getAttribute("data-auth-switch");
      if (mode === "register") showRegisterForm();
      else showLoginForm();
    });
  });

  // data-auth-tab (auth modal tabs)
  if (authTabLogin) authTabLogin.addEventListener("click", function (e) { e.preventDefault(); showLoginForm(); });
  if (authTabRegister) authTabRegister.addEventListener("click", function (e) { e.preventDefault(); showRegisterForm(); });

  // data-start-free buttons (hero + final CTA)
  document.querySelectorAll("[data-start-free]").forEach(function (el) {
    el.addEventListener("click", function (e) {
      e.preventDefault();
      closeNav();
      if (currentUser) {
        smoothScroll("#product");
        showToast("You're already signed in. Open the extension to start scanning.");
      } else {
        openAuthModal("register");
      }
    });
  });

  // data-extension (Open Extension)
  document.querySelectorAll("[data-extension]").forEach(function (el) {
    el.addEventListener("click", handleOpenExtension);
  });

  // data-pricing (Free / Pro / Agency)
  document.querySelectorAll("[data-pricing]").forEach(function (el) {
    el.addEventListener("click", function (e) {
      var plan = el.getAttribute("data-pricing");
      handlePricing(plan, e);
    });
  });

  // data-placeholder (privacy / terms)
  var PLACEHOLDER_MESSAGES = {
    privacy: "The Privacy page is coming soon.",
    terms: "The Terms page is coming soon."
  };
  document.querySelectorAll("[data-placeholder]").forEach(function (el) {
    el.addEventListener("click", function (e) {
      e.preventDefault();
      closeNav();
      var key = el.getAttribute("data-placeholder");
      showToast(PLACEHOLDER_MESSAGES[key] || "This feature is coming soon.");
    });
  });

  // CTA click tracking hooks (analytics placeholder)
  document.querySelectorAll("[data-track]").forEach(function (el) {
    el.addEventListener("click", function () {
      var id = el.getAttribute("data-track");
      /* TODO: Replace with analytics event when tracking is set up */
      console.log("[AdVault Spy landing] CTA clicked:", id);
    });
  });

  // Form submits
  if (loginForm) loginForm.addEventListener("submit", handleLogin);
  if (registerForm) registerForm.addEventListener("submit", handleRegister);
  if (forgotPasswordForm) forgotPasswordForm.addEventListener("submit", handleForgotPasswordSubmit);
  if (resetPasswordForm) resetPasswordForm.addEventListener("submit", handleResetPasswordSubmit);
  if (resetPasswordModalClose) resetPasswordModalClose.addEventListener("click", function () { closeModal(resetPasswordModal); });
  document.querySelectorAll("[data-reset-back]").forEach(function (el) {
    el.addEventListener("click", function (e) { e.preventDefault(); closeModal(resetPasswordModal); openAuthModal("login"); });
  });

  // Modal close (X buttons)
  if (authModalClose) authModalClose.addEventListener("click", function () { closeModal(authModal); });
  if (accountModalClose) accountModalClose.addEventListener("click", function () { closeModal(accountModal); });

  // Backdrop click closes modal
  [authModal, accountModal, verificationModal, resetPasswordModal].forEach(function (modal) {
    if (!modal) return;
    modal.addEventListener("click", function (e) {
      if (e.target === modal) closeModal(modal);
    });
  });

  // Escape closes modal / dropdown / nav
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if (authModal && !authModal.classList.contains("is-hidden")) {
        closeModal(authModal);
      } else if (accountModal && !accountModal.classList.contains("is-hidden")) {
        closeModal(accountModal);
      } else if (verificationModal && !verificationModal.classList.contains("is-hidden")) {
        closeModal(verificationModal);
      } else if (accountDropdown && !accountDropdown.classList.contains("is-hidden")) {
        closeAccountDropdown();
      } else {
        closeNav();
      }
    }
  });

  // Verification modal actions
  if (resendVerificationBtn) resendVerificationBtn.addEventListener("click", handleResendVerification);
  if (changeEmailBtn) changeEmailBtn.addEventListener("click", function (e) {
    e.preventDefault();
    closeVerificationModal();
    openAuthModal("register");
  });
  if (verificationLoginBtn) verificationLoginBtn.addEventListener("click", handleVerificationSuccess);

  // Login resend verification link
  if (loginResendVerification) loginResendVerification.addEventListener("click", handleResendVerification);

  // Account chip toggle
  if (accountChip) {
    accountChip.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      toggleAccountDropdown();
    });
  }

  // Close dropdown on outside click
  document.addEventListener("click", function (e) {
    if (accountDropdown && !accountDropdown.classList.contains("is-hidden") && accountWrap && !accountWrap.contains(e.target)) {
      closeAccountDropdown();
    }
  });

  // Account dropdown actions
  if (ddManage) {
    ddManage.addEventListener("click", function (e) {
      e.preventDefault();
      closeAccountDropdown();
      openAccountModal();
    });
  }

  if (ddUpgrade) {
    ddUpgrade.addEventListener("click", function (e) {
      e.preventDefault();
      closeAccountDropdown();
      handlePricing("pro", e);
    });
  }

  if (ddLogout) {
    ddLogout.addEventListener("click", function (e) {
      e.preventDefault();
      handleLogout(e);
    });
  }

  // Account modal actions
  if (accountUpgrade) {
    accountUpgrade.addEventListener("click", function (e) {
      e.preventDefault();
      handlePricing("pro", e);
    });
  }
  if (accountLogout) accountLogout.addEventListener("click", handleLogout);

/* ============================================================
      SESSION RESTORE
      ============================================================ */
  function restoreSession() {
    var token = null;
    try { token = localStorage.getItem(AUTH_TOKEN_KEY); } catch (e) { /* ignore */ }
    if (!token) {
      renderAuthState();
      return;
    }
    authToken = token;
    apiRequest("/auth/me")
      .then(function (res) {
        if (res.ok && res.data && res.data.user) {
          applySession(res.data);
        } else if (res.status === 401) {
          // Token invalid/expired — clear it and return to logged-out state.
          clearSession();
          showToast("Your session has expired. Please log in again.", "error");
        } else {
          currentUser = null;
          renderAuthState();
        }
      })
      .catch(function () {
        // Backend unavailable: keep token, render logged-out UI.
        currentUser = null;
        renderAuthState();
      });
  }

  /* ============================================================
      EMAIL VERIFICATION FROM URL
      ============================================================ */
  function handleVerificationFromUrl() {
    var params = new URLSearchParams(window.location.search);
    var token = params.get("token");
    if (!token) return;

    // Call the verification endpoint
    apiRequest("/auth/verify-email?token=" + encodeURIComponent(token))
      .then(function (res) {
        if (res.ok) {
          // openVerificationModal resets the modal to its "pending" state, so it
          // must run BEFORE showVerificationSuccess — otherwise the success
          // panel would be hidden again before the modal is shown.
          openVerificationModal("");
          showVerificationSuccess();
          // Clean up URL
          var cleanUrl = window.location.pathname;
          window.history.replaceState({}, document.title, cleanUrl);
        } else {
          var msg = res.data && res.data.message ? res.data.message : "This verification link is invalid.";
          if (res.data && res.data.error === "TOKEN_EXPIRED") {
            msg = "This verification link has expired. Request a new verification email.";
          } else if (res.data && res.data.error === "TOKEN_USED") {
            msg = "Your email has already been verified. You can log in.";
          }
          showToast(msg, "error");
          // Clean up URL
          var cleanUrl = window.location.pathname;
          window.history.replaceState({}, document.title, cleanUrl);
        }
      })
      .catch(function () {
        showToast("Unable to verify email. Please try again.", "error");
        var cleanUrl = window.location.pathname;
        window.history.replaceState({}, document.title, cleanUrl);
      });
  }

/* ============================================================
      INIT
      ============================================================ */
  var yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  renderAuthState();
  restoreSession();
  handleVerificationFromUrl();
})();
