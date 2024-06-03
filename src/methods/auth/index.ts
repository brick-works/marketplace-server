import { Elysia, t } from 'elysia';
import { supabase, supabaseAuthAdapter } from '../../supabase';
import { v4 as uuid } from 'uuid';
import { SignedMessage } from './signedMessage';

export type Nonce = {
    address: string;
};

export type Login = {
    message: string;
    signature: string;
};

export const NonceSchema = t.Object({
    address: t.String(),
});

export const LoginSchema = t.Object({
    message: t.String(),
    signature: t.String(),
});

export const authManager = new Elysia({ prefix: '/auth' })
    .post('/nonce', async ({ body }) => {
        const { address } = body;

        try {
            const nonce = uuid();
            const attempt = {
                address,
                nonce,
                ttl: (Math.floor(Date.now() / 1000) + 300).toString(), // 5 minutes TTL
            };

            await supabaseAuthAdapter.saveAttempt(attempt);

            return new Response(JSON.stringify({ nonce }), {
                headers: { 'Content-Type': 'application/json' },
            });
        } catch (error) {
            console.error('Error generating nonce:', error);
            return new Response(JSON.stringify({ error: 'Failed to generate nonce' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
            });
        }
    }, { body: NonceSchema })

    .post('/login', async ({ body }) => {
        const { message, signature } = body;

        try {
            // Validate the signed message
            const signinMessage = new SignedMessage(JSON.parse(message));
            const validationResult = await signinMessage.validate(signature);

            if (!validationResult) {
                return new Response(JSON.stringify({ error: 'Invalid signature' }), {
                    status: 401,
                    headers: { 'Content-Type': 'application/json' },
                });
            }

            // Check if the nonce is valid
            const storedNonce = await supabaseAuthAdapter.getNonce(signinMessage.publicKey);
            if (storedNonce !== signinMessage.nonce) {
                return new Response(JSON.stringify({ error: 'Invalid nonce' }), {
                    status: 401,
                    headers: { 'Content-Type': 'application/json' },
                });
            }

            // Check if user exists, otherwise create a new one
            const { data: user, error: userError } = await supabase
                .from('users')
                .select('*')
                .eq('id', signinMessage.publicKey)
                .single();

            let userId;
            if (userError && userError.code !== 'PGRST116') {
                throw userError;
            } else if (!user) {
                const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
                    email: `${signinMessage.publicKey}@example.com`, // Placeholder email
                    user_metadata: { address: signinMessage.publicKey },
                });

                if (authError) {
                    throw authError;
                }
                userId = authUser.user.id;

                await supabase
                    .from('users')
                    .insert({ id: userId, address: signinMessage.publicKey });
            } else {
                userId = user.id;
            }

            // Generate JWT token
            const token = supabaseAuthAdapter.generateToken();
            const session = await supabase.auth.setSession({ 
                access_token: token, 
                refresh_token: token
            })
            console.log(session)
            // Clear the nonce after successful login
            await supabase
                .from('users')
                .update({ 
                    nonce: null, 
                    last_auth: new Date().toISOString(), 
                    last_auth_status: 'success' 
                })
                .eq('address', signinMessage.publicKey);

            return new Response(JSON.stringify({ token }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        } catch (error: any) {
            console.error('Error during login:', error);
            return new Response(JSON.stringify({ error: error.message || 'Login failed' }), {
                status: error.status || 500,
                headers: { 'Content-Type': 'application/json' },
            });
        }
    }, { body: LoginSchema });
