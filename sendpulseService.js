import axios from 'axios';

export class SendPulseService {
    constructor() {
        this.clientId = process.env.SENDPULSE_CLIENT_ID;
        this.clientSecret = process.env.SENDPULSE_CLIENT_SECRET;
        this.baseUrl = 'https://api.sendpulse.com';
        this.token = null;
        this.tokenExpires = null;
    }

    async getToken(forceRefresh = false) {
        // Если токен есть и не истек, возвращаем его
        if (!forceRefresh && this.token && this.tokenExpires && Date.now() < this.tokenExpires - 60000) {
            return this.token;
        }

        try {
            console.log('Getting new SendPulse token...');
            const response = await axios.post(`${this.baseUrl}/oauth/access_token`, {
                grant_type: 'client_credentials',
                client_id: this.clientId,
                client_secret: this.clientSecret
            });

            this.token = response.data.access_token;
            // Устанавливаем время истечения на минуту раньше реального для подстраховки
            this.tokenExpires = Date.now() + ((response.data.expires_in - 60) * 1000);
            console.log('New SendPulse token received');
            return this.token;
        } catch (error) {
            console.error('Error getting SendPulse token:', error.response ? error.response.data : error);
            throw error;
        }
    }

    async makeRequest(method, endpoint, data = null) {
        const maxRetries = 2;
        let lastError = null;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const token = await this.getToken(attempt > 0);
                
                const config = {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                };

                const url = `${this.baseUrl}${endpoint}`;
                
                if (method === 'GET') {
                    const response = await axios.get(url, config);
                    return response.data;
                } else if (method === 'POST') {
                    const response = await axios.post(url, data, config);
                    return response.data;
                }
            } catch (error) {
                lastError = error;
                
                // Если ошибка 401 (истекший токен), пробуем получить новый токен
                if (error.response && error.response.status === 401) {
                    console.log('Token expired, will retry with new token...');
                    if (attempt < maxRetries) {
                        continue;
                    }
                }
                
                throw error;
            }
        }

        throw lastError;
    }

    async createContact(phoneNumber, carTitle) {
        try {
            const cleanPhone = phoneNumber.replace(/\D/g, '');
            
            const contactData = {
                firstName: carTitle || 'Новый контакт',
                channels: [{
                    type: 'phone',
                    value: cleanPhone
                }]
            };

            const response = await this.makeRequest('POST', '/crm/v1/contacts', contactData);
            return response.id;
        } catch (error) {
            console.error('Error creating contact:', error.response ? error.response.data : error);
            throw error;
        }
    }

    async addDeal(phone, url, price, title) {
        try {
            if (!phone || phone === 'Телефон на сайті') {
                console.log('Invalid phone number, skipping SendPulse');
                return false;
            }

            console.log(`Creating SendPulse deal for ${phone} (${title})`);
            
            // Очищаем номер телефона от всех нецифровых символов
            const cleanPhone = phone.replace(/\D/g, '');
            
            // Преобразуем цену в число
            const numericPrice = parseInt(price.replace(/\D/g, ''));
            
            // Сначала создаем контакт
            const contactId = await this.createContact(cleanPhone, title);
            
            // Создаем сделку с ценой и названием машины
            const dealData = {
                pipelineId: 130957,
                stepId: 451337,
                name: title,
                price: numericPrice,
                currency: 'USD',
                attributes: [
                    {
                        attributeId: 780917,
                        value: cleanPhone
                    },
                    {
                        attributeId: 780918,
                        value: url
                    }
                ],
                contact: contactId
            };

            await this.makeRequest('POST', '/crm/v1/deals', dealData);

            console.log(`✓ Successfully added deal "${title}" with price ${numericPrice} USD for phone: ${phone}`);
            return true;
        } catch (error) {
            console.error('Error in SendPulse CRM operation:', error.response ? error.response.data : error);
            return false;
        }
    }
}