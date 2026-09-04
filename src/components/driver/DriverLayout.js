import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { isDriverSignedIn } from '../../lib/driverSession';
import DriverApprovalGate from './DriverApprovalGate';
import DriverBottomNav from './DriverBottomNav';
import { DriverOffersProvider } from './DriverOffersProvider';
import './DriverApp.css';

export default function DriverLayout() {
  const location = useLocation();
  if (!isDriverSignedIn()) {
    return <Navigate to="/driver/login" replace state={{ from: location.pathname }} />;
  }
  // The offer screen is a call screen: no tab bar under Accept / Decline.
  const hideNav = location.pathname.startsWith('/driver/offer/');
  return (
    <DriverApprovalGate>
      <DriverOffersProvider>
        <div className={hideNav ? 'driver-app driver-app--noNav' : 'driver-app'}>
          <div className="driver-app__outlet">
            <Outlet />
          </div>
          {hideNav ? null : <DriverBottomNav />}
        </div>
      </DriverOffersProvider>
    </DriverApprovalGate>
  );
}
