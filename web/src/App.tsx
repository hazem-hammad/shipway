import { Redirect, Route, Switch } from 'wouter';
import { useMe, useSetupStatus } from './hooks';
import { ShellSkeleton } from './components/ui';
import Layout from './components/Layout';
import Login from './pages/Login';
import SetupWizard from './pages/SetupWizard';
import ProjectsPage from './pages/Projects';
import ProjectNewPage from './pages/ProjectNew';
import DatabasesPage from './pages/Databases';
import ServerPage from './pages/Server';
import SettingsPage from './pages/Settings';

export default function App() {
  const setupStatus = useSetupStatus();

  if (setupStatus.isPending) {
    return <ShellSkeleton />;
  }

  if (setupStatus.data?.needsSetup) {
    return (
      <Switch>
        <Route path="/setup" component={SetupWizard} />
        <Route>
          <Redirect to="/setup" />
        </Route>
      </Switch>
    );
  }

  return <AuthenticatedGate />;
}

function AuthenticatedGate() {
  const me = useMe();

  if (me.isPending) {
    return <ShellSkeleton />;
  }

  if (!me.data) {
    return (
      <Switch>
        <Route path="/login" component={Login} />
        <Route>
          <Redirect to="/login" />
        </Route>
      </Switch>
    );
  }

  return (
    <Layout user={me.data}>
      <Switch>
        <Route path="/projects/new" component={ProjectNewPage} />
        <Route path="/projects" component={ProjectsPage} />
        <Route path="/databases" component={DatabasesPage} />
        <Route path="/server" component={ServerPage} />
        <Route path="/settings/:section?" component={SettingsPage} />
        <Route>
          <Redirect to="/projects" />
        </Route>
      </Switch>
    </Layout>
  );
}
