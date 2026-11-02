import { Header } from '@/components/Header';
import { currentUser } from '@/lib/auth';
import Chat, { Login } from './Chat';

// Renders the chat for signed-in users, otherwise the login screen
export default async function Home() {
  const user = await currentUser();
  return (
    <>
      <Header user={user?.name} />
      {user ? <Chat /> : <Login />}
    </>
  );
}
