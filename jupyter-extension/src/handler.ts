import { URLExt } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';

/**
 * Appel a un endpoint de l'extension server-side saasy_jupyter_odoo.
 *
 * @param endPoint - Path apres /saasy-odoo/ (e.g. "update", "logs")
 * @param init - Options fetch (method, body, etc.)
 */
export async function requestAPI<T>(
  endPoint = '',
  init: RequestInit = {}
): Promise<T> {
  const settings = ServerConnection.makeSettings();
  const requestUrl = URLExt.join(settings.baseUrl, 'saasy-odoo', endPoint);

  let response: Response;
  try {
    response = await ServerConnection.makeRequest(requestUrl, init, settings);
  } catch (error) {
    throw new ServerConnection.NetworkError(error as TypeError);
  }

  let data: any = await response.text();
  if (data.length > 0) {
    try {
      data = JSON.parse(data);
    } catch (error) {
      console.warn('Cannot parse response as JSON.', error);
    }
  }

  if (!response.ok) {
    throw new ServerConnection.ResponseError(response, data?.error || data);
  }

  return data as T;
}
