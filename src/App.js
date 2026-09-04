import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { getCustomerSession, isCustomerMarkedSignedIn } from './lib/customerSession';
import { isDriverSignedIn } from './lib/driverSession';
import { isShopOwnerSignedIn } from './lib/shopOwnerAuth';
import { consumeDebugGeoQueryParam } from './lib/geoDebug';
import OnboardingScreen from './components/OnboardingScreen';
import './App.css';
import CustomerLayout from './components/customer/CustomerLayout';
import CustomerHomePage from './pages/CustomerHomePage';
import LoginPage from './pages/LoginPage';
import ForgotPasswordPage from './pages/ForgotPasswordPage';
import OrderDetailsPage from './pages/OrderDetailsPage';
import OrderHistoryPage from './pages/OrderHistoryPage';
import ProfilePage from './pages/ProfilePage';
import ProfileEditPage from './pages/ProfileEditPage';
import WalletPage from './pages/WalletPage';
import WalletTopUpPage from './pages/WalletTopUpPage';
import PackageDetailsPage from './pages/PackageDetailsPage';
import PriceEstimatePage from './pages/PriceEstimatePage';
import RegisterPage from './pages/RegisterPage';
import TermsPage from './pages/TermsPage';
import PrivacyPolicyPage from './pages/PrivacyPolicyPage';
import HelpSupportPage from './pages/HelpSupportPage';
import FAQsPage from './pages/FAQsPage';
import RequestDeliveryPage from './pages/RequestDeliveryPage';
import RequestServiceChoicePage from './pages/RequestServiceChoicePage';
import StripeCancelPage from './pages/StripeCancelPage';
import StripeReturnPage from './pages/StripeReturnPage';
import EcocashWaitingPage from './pages/EcocashWaitingPage';
import OrderConfirmationPage from './pages/OrderConfirmationPage';
import LiveTrackingPage from './pages/LiveTrackingPage';
import { ShopCartProvider } from './context/ShopCartContext';
import CustomerShopsPage from './pages/CustomerShopsPage';
import ShopCartPage from './pages/ShopCartPage';
import ShopCheckoutPage from './pages/ShopCheckoutPage';
import ShopDetailPage from './pages/ShopDetailPage';
import ProductDetailPage from './pages/ProductDetailPage';
import TaxiBookingPage from './pages/TaxiBookingPage';
import TukTukBookingPage from './pages/TukTukBookingPage';
import ChatPage from './pages/ChatPage';
import NotificationsPage from './pages/NotificationsPage';
import RateExperiencePage from './pages/RateExperiencePage';
import DriverLayout from './components/driver/DriverLayout';
import DriverAuthGate from './components/driver/DriverAuthGate';
import DriverRegisterPage from './pages/DriverRegisterPage';
import DriverLoginPage from './pages/DriverLoginPage';
import DriverHomePage from './pages/DriverHomePage';
import DriverOfferPage from './pages/DriverOfferPage';
import DriverOrdersPage from './pages/DriverOrdersPage';
import DriverEarningsPage from './pages/DriverEarningsPage';
import DriverWalletPage from './pages/DriverWalletPage';
import DriverProfilePage from './pages/DriverProfilePage';
import DriverNotificationsPage from './pages/DriverNotificationsPage';
import DriverSupportChatPage from './pages/DriverSupportChatPage';
import DriverCompanyFleetPage from './pages/DriverCompanyFleetPage';
import DriverActiveDeliveryPage from './pages/DriverActiveDeliveryPage';
import DriverPickupConfirmPage from './pages/DriverPickupConfirmPage';
import DriverNavigationPage from './pages/DriverNavigationPage';
import DriverDeliveryStatusPage from './pages/DriverDeliveryStatusPage';
import DriverCollectPaymentPage from './pages/DriverCollectPaymentPage';
import DriverRateCustomerPage from './pages/DriverRateCustomerPage';
import ShopOwnerLayout from './components/shopOwner/ShopOwnerLayout';
import ShopOwnerLoginPage from './pages/ShopOwnerLoginPage';
import ShopOwnerRegisterPage from './pages/ShopOwnerRegisterPage';
import ShopOwnerDashboardPage from './pages/ShopOwnerDashboardPage';
import ShopOwnerOrdersPage from './pages/ShopOwnerOrdersPage';
import ShopOwnerOrderDetailPage from './pages/ShopOwnerOrderDetailPage';
import ShopOwnerProductsPage from './pages/ShopOwnerProductsPage';
import ShopOwnerAddProductPage from './pages/ShopOwnerAddProductPage';
import ShopOwnerDeliveryDriverPage from './pages/ShopOwnerDeliveryDriverPage';
import ShopOwnerProfilePage from './pages/ShopOwnerProfilePage';
import ShopOwnerSupportPage from './pages/ShopOwnerSupportPage';
import ShopOwnerSupportChatPage from './pages/ShopOwnerSupportChatPage';
import ShopOwnerPaymentsPage from './pages/ShopOwnerPaymentsPage';
import ShopOwnerAnalyticsPage from './pages/ShopOwnerAnalyticsPage';
import ShopOwnerNotificationsPage from './pages/ShopOwnerNotificationsPage';
import AdminLoginPage from './pages/AdminLoginPage';
import AdminLayout from './components/admin/AdminLayout';
import AdminDashboardPage from './pages/AdminDashboardPage';
import AdminCustomerManagementPage from './pages/AdminCustomerManagementPage';
import AdminSearchPromoCodesPage from './pages/AdminSearchPromoCodesPage';
import AdminDriverManagementPage from './pages/AdminDriverManagementPage';
import AdminDriverRequestsPage from './pages/AdminDriverRequestsPage';
import AdminOurDriversPage from './pages/AdminOurDriversPage';
import AdminDriverLocationsPage from './pages/AdminDriverLocationsPage';
import AdminOrderManagementPage from './pages/AdminOrderManagementPage';
import AdminDeliveryOrdersPage from './pages/AdminDeliveryOrdersPage';
import AdminShopOrdersPage from './pages/AdminShopOrdersPage';
import AdminShopOrdersDeliveryPage from './pages/AdminShopOrdersDeliveryPage';
import AdminProductsPage from './pages/AdminProductsPage';
import AdminTaxiBookingsPage from './pages/AdminTaxiBookingsPage';
import AdminCancelledRidesPage from './pages/AdminCancelledRidesPage';
import AdminTukTukBookingsPage from './pages/AdminTukTukBookingsPage';
import AdminPricingConfigurationPage from './pages/AdminPricingConfigurationPage';
import AdminServiceRatesPage from './pages/AdminServiceRatesPage';
import AdminPlatformCommissionPage from './pages/AdminPlatformCommissionPage';
import AdminShopDeliveryPricePage from './pages/AdminShopDeliveryPricePage';
import AdminPaymentsPage from './pages/AdminPaymentsPage';
import AdminDisputesSupportPage from './pages/AdminDisputesSupportPage';
import AdminCommunicationsPage from './pages/AdminCommunicationsPage';
import AdminReportsPage from './pages/AdminReportsPage';
import AdminSettingsPage from './pages/AdminSettingsPage';
import AdminShopOwnerManagementPage from './pages/AdminShopOwnerManagementPage';
import AdminNotificationManagementPage from './pages/AdminNotificationManagementPage';
import AdminSystemHealthPage from './pages/AdminSystemHealthPage';
import AdminAnalyticsPage from './pages/AdminAnalyticsPage';
import AdminBIPage from './pages/AdminBIPage';
import AdminTransactionsPage from './pages/AdminTransactionsPage';
import AdminSupportTicketsPage from './pages/AdminSupportTicketsPage';
import AdminReviewsPage from './pages/AdminReviewsPage';
import AdminDriverWithdrawalsPage from './pages/AdminDriverWithdrawalsPage';
import AdminShopWithdrawalsPage from './pages/AdminShopWithdrawalsPage';
import AdminWalletsPage from './pages/AdminWalletsPage';
import MapsDebugPage from './pages/MapsDebugPage';
import DesktopAdminOnlyGuard from './components/DesktopAdminOnlyGuard';

const STORAGE_KEY = 'ingo_onboarding_complete';

const ShopOwnerDeliveryRequestsPage = lazy(() => import('./pages/ShopOwnerDeliveryRequestsPage'));
const SelectPaymentPage = lazy(() => import('./pages/SelectPaymentPage'));

function ScrollToTopOnRouteChange() {
  const location = useLocation();
  useEffect(() => {
    try {
      if (typeof window !== 'undefined' && window.history?.scrollRestoration) {
        window.history.scrollRestoration = 'manual';
      }
    } catch {
      // ignore
    }
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    // Also reset common app shell scroll containers.
    document.querySelector('.driver-app__outlet')?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    document.querySelector('.sopCont')?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    document.querySelector('.admContent')?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    document.querySelector('.customer-app__outlet')?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [location.pathname]);
  return null;
}

function RootFlow() {
  // Show onboarding on first run; otherwise go to login (or home if already signed in).
  const [view, setView] = useState(() => {
    try {
      if (typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY) === '1') {
        return 'main';
      }
    } catch {
      // ignore
    }
    return 'onboarding';
  });

  const finishOnboarding = useCallback(() => {
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      // ignore
    }
    setView('main');
  }, []);

  if (view === 'onboarding') {
    return <OnboardingScreen onComplete={finishOnboarding} />;
  }
  // Prefer the last active portal session so reopening the app skips customer login.
  if (isDriverSignedIn()) {
    return <Navigate to="/driver/home" replace />;
  }
  if (isShopOwnerSignedIn()) {
    return <Navigate to="/shop-owner/dashboard" replace />;
  }
  if (isCustomerMarkedSignedIn() && getCustomerSession()) {
    return <Navigate to="/home" replace />;
  }
  return <Navigate to="/login" replace />;
}

function App() {
  useEffect(() => {
    consumeDebugGeoQueryParam();
  }, []);

  return (
    <BrowserRouter>
      <ScrollToTopOnRouteChange />
      <DesktopAdminOnlyGuard>
        <ShopCartProvider>
          <div className="App">
            <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/terms" element={<TermsPage />} />
            <Route path="/privacy-policy" element={<PrivacyPolicyPage />} />
            <Route path="/help-support" element={<HelpSupportPage />} />
            <Route path="/faqs" element={<FAQsPage />} />
            <Route path="/request-now" element={<RequestServiceChoicePage />} />
            <Route path="/request-delivery" element={<RequestDeliveryPage />} />
            <Route path="/package-details" element={<PackageDetailsPage />} />
            <Route path="/price-estimate" element={<PriceEstimatePage />} />
            <Route
              path="/select-payment"
              element={
                <Suspense fallback={<div style={{ padding: '1rem', fontFamily: 'system-ui' }}>Loading…</div>}>
                  <SelectPaymentPage />
                </Suspense>
              }
            />
            <Route path="/stripe-return" element={<StripeReturnPage />} />
            <Route path="/stripe-cancel" element={<StripeCancelPage />} />
            <Route path="/ecocash-waiting" element={<EcocashWaitingPage />} />
            <Route path="/live-tracking" element={<LiveTrackingPage />} />
            <Route path="/maps" element={<MapsDebugPage />} />
            <Route path="/book-ride" element={<TaxiBookingPage />} />
            <Route path="/book-tuk-tuk" element={<TukTukBookingPage />} />
            <Route path="/chat" element={<ChatPage />} />
            <Route path="/rate" element={<RateExperiencePage />} />
            <Route path="/rate/:orderId" element={<RateExperiencePage />} />
            <Route path="/" element={<RootFlow />} />
            <Route path="/order/:orderId" element={<OrderDetailsPage />} />
            <Route path="/driver/login" element={<DriverLoginPage />} />
            <Route path="/driver/register" element={<DriverRegisterPage />} />
            <Route
              path="/driver/active-delivery/:jobKey?"
              element={
                <DriverAuthGate>
                  <DriverActiveDeliveryPage />
                </DriverAuthGate>
              }
            />
            <Route
              path="/driver/confirm-pickup/:jobKey?"
              element={
                <DriverAuthGate>
                  <DriverPickupConfirmPage />
                </DriverAuthGate>
              }
            />
            <Route
              path="/driver/navigation/:jobKey?"
              element={
                <DriverAuthGate>
                  <DriverNavigationPage />
                </DriverAuthGate>
              }
            />
            <Route
              path="/driver/delivery-status/:jobKey?"
              element={
                <DriverAuthGate>
                  <DriverDeliveryStatusPage />
                </DriverAuthGate>
              }
            />
            <Route
              path="/driver/collect-payment/:jobKey?"
              element={
                <DriverAuthGate>
                  <DriverCollectPaymentPage />
                </DriverAuthGate>
              }
            />
            <Route
              path="/driver/rate-customer/:jobKey?"
              element={
                <DriverAuthGate>
                  <DriverRateCustomerPage />
                </DriverAuthGate>
              }
            />
            <Route path="/driver" element={<DriverLayout />}>
              <Route index element={<Navigate to="home" replace />} />
              <Route path="home" element={<DriverHomePage />} />
              <Route path="offer/:offerKey" element={<DriverOfferPage />} />
              <Route path="orders" element={<DriverOrdersPage />} />
              <Route path="earnings" element={<DriverEarningsPage />} />
              <Route path="wallet" element={<DriverWalletPage />} />
              <Route path="fleet" element={<DriverCompanyFleetPage />} />
              <Route path="profile" element={<DriverProfilePage />} />
              <Route path="notifications" element={<DriverNotificationsPage />} />
              <Route path="chat" element={<DriverSupportChatPage />} />
            </Route>
            <Route path="/shop-owner/login" element={<ShopOwnerLoginPage />} />
            <Route path="/shop-owner/register" element={<ShopOwnerRegisterPage />} />
            <Route path="/admin/login" element={<AdminLoginPage />} />
            <Route path="/admin" element={<AdminLayout />}>
              <Route index element={<Navigate to="dashboard" replace />} />
              <Route path="dashboard" element={<AdminDashboardPage />} />
              <Route path="customers" element={<AdminCustomerManagementPage />} />
              <Route path="search-promo-codes" element={<AdminSearchPromoCodesPage />} />
              <Route path="drivers" element={<AdminDriverManagementPage />} />
              <Route path="driver-requests" element={<AdminDriverRequestsPage />} />
              <Route path="our-drivers" element={<AdminOurDriversPage />} />
              <Route path="driver-locations" element={<AdminDriverLocationsPage />} />
              <Route path="analytics" element={<AdminAnalyticsPage />} />
              <Route path="bi" element={<AdminBIPage />} />
              <Route
                path="shop-owners"
                element={<AdminShopOwnerManagementPage />}
              />
              <Route path="orders" element={<AdminOrderManagementPage />} />
              <Route path="delivery-orders" element={<AdminDeliveryOrdersPage />} />
              <Route path="shop-orders" element={<AdminShopOrdersPage />} />
              <Route path="products" element={<AdminProductsPage />} />
              <Route path="shop-orders-delivery" element={<AdminShopOrdersDeliveryPage />} />
              <Route path="taxi-bookings" element={<AdminTaxiBookingsPage />} />
              <Route path="cancelled-rides" element={<AdminCancelledRidesPage />} />
              <Route path="tuk-tuk-bookings" element={<AdminTukTukBookingsPage />} />
              <Route path="payments" element={<AdminPaymentsPage />} />
              <Route path="wallets" element={<AdminWalletsPage />} />
              <Route path="driver-withdrawals" element={<AdminDriverWithdrawalsPage />} />
              <Route path="shop-withdrawals" element={<AdminShopWithdrawalsPage />} />
              <Route path="transactions" element={<AdminTransactionsPage />} />
              <Route path="pricing" element={<AdminPricingConfigurationPage />} />
              <Route path="service-rates" element={<AdminServiceRatesPage />} />
              <Route path="platform-commission" element={<AdminPlatformCommissionPage />} />
              <Route path="shop-delivery-price" element={<AdminShopDeliveryPricePage />} />
              <Route
                path="disputes"
                element={<AdminDisputesSupportPage />}
              />
              <Route
                path="support"
                element={<AdminSupportTicketsPage />}
              />
              <Route path="reviews" element={<AdminReviewsPage />} />
              <Route
                path="notifications"
                element={<AdminNotificationManagementPage />}
              />
              <Route
                path="communications"
                element={<AdminCommunicationsPage />}
              />
              <Route
                path="reports"
                element={<AdminReportsPage />}
              />
              <Route
                path="settings"
                element={<AdminSettingsPage />}
              />
              <Route path="system-health" element={<AdminSystemHealthPage />} />
            </Route>
            <Route path="/shop-owner" element={<ShopOwnerLayout />}>
              <Route index element={<Navigate to="dashboard" replace />} />
              <Route path="dashboard" element={<ShopOwnerDashboardPage />} />
              <Route path="orders" element={<ShopOwnerOrdersPage />} />
              <Route path="orders/:orderId" element={<ShopOwnerOrderDetailPage />} />
              <Route path="delivery-driver" element={<ShopOwnerDeliveryDriverPage />} />
              <Route path="products/new" element={<ShopOwnerAddProductPage />} />
              <Route path="products" element={<ShopOwnerProductsPage />} />
              <Route
                path="delivery-requests"
                element={
                  <Suspense fallback={<div style={{ padding: '1rem', fontFamily: 'system-ui' }}>Loading…</div>}>
                    <ShopOwnerDeliveryRequestsPage />
                  </Suspense>
                }
              />
              <Route path="payments" element={<ShopOwnerPaymentsPage />} />
              <Route path="analytics" element={<ShopOwnerAnalyticsPage />} />
              <Route path="notifications" element={<ShopOwnerNotificationsPage />} />
              <Route path="chat" element={<ShopOwnerSupportChatPage />} />
              <Route path="profile" element={<ShopOwnerProfilePage />} />
              <Route path="support" element={<ShopOwnerSupportPage />} />
              <Route path="support/chat" element={<ShopOwnerSupportChatPage />} />
            </Route>
            <Route element={<CustomerLayout />}>
              <Route path="order-confirmation" element={<OrderConfirmationPage />} />
              <Route path="notifications" element={<NotificationsPage />} />
              <Route path="shop/cart" element={<ShopCartPage />} />
              <Route path="shop/checkout" element={<ShopCheckoutPage />} />
              <Route path="shops" element={<CustomerShopsPage />} />
              <Route path="shop/:shopId/product/:productId" element={<ProductDetailPage />} />
              <Route path="shop/:shopId" element={<ShopDetailPage />} />
              <Route path="shop" element={<Navigate to="/shops" replace />} />
              <Route path="home" element={<CustomerHomePage />} />
              <Route path="orders" element={<OrderHistoryPage />} />
              <Route path="wallet" element={<WalletPage />} />
              <Route path="wallet/top-up" element={<WalletTopUpPage />} />
              <Route path="profile" element={<ProfilePage />} />
              <Route path="profile/edit" element={<ProfileEditPage />} />
              <Route path="chat/support" element={<ChatPage support />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </div>
        </ShopCartProvider>
      </DesktopAdminOnlyGuard>
    </BrowserRouter>
  );
}

export default App;
