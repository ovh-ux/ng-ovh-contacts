import angular from 'angular';
import moment from 'moment';

// lodash imports
import find from 'lodash/find';
import forIn from 'lodash/forIn';
import get from 'lodash/get';
import groupBy from 'lodash/groupBy';
import has from 'lodash/has';
import includes from 'lodash/includes';
import isEqual from 'lodash/isEqual';
import map from 'lodash/map';
import merge from 'lodash/merge';
import size from 'lodash/size';
import set from 'lodash/set';
import startsWith from 'lodash/startsWith';

import {
  CONTACT_TO_NIC_FIELDS_MAPPING,
} from '../ovh-contacts.constants';

const getMappedKey = (property, path) => {
  let mappedKey = property;

  if (has(CONTACT_TO_NIC_FIELDS_MAPPING, path)) {
    mappedKey = get(CONTACT_TO_NIC_FIELDS_MAPPING, path);
  }
  return mappedKey;
};

export default class OvhContactsHelper {
  /**
   *  Filter the contacts in given list that have the same lastName, firstName and address
   *  @param  {Array} contacts The list of contacts to filter
   *  @return {Array}          The contacts list without duplicates.
   */
  static filterSimilarContacts(contacts) {
    const groupedContacts = groupBy(contacts, (contact) => {
      // group contact to detect contact that are the same
      const contactCopy = {
        lastName: contact.lastName,
        firstName: contact.firstName,
        email: contact.email,
      };
      if (contact.address) {
        contactCopy.address = {
          country: contact.address.country,
          line1: contact.address.line1,
          zip: contact.address.zip,
          city: contact.address.city,
        };
      }
      return JSON.stringify(contactCopy);
    });

    return map(groupedContacts, groups => groups[0]);
  }

  static normalizeDate(date) {
    if (!date) {
      return null;
    }

    // check if date is valid
    const momentDate = moment(new Date(date));
    if (!momentDate.isValid()) {
      return null;
    }

    return momentDate.format('YYYY-MM-DD');
  }

  static normalizePhoneNumber(phoneNumberParam, phonePrefix) {
    let phoneNumber = phoneNumberParam;
    if (phoneNumber) {
      phoneNumber = phoneNumber.replace(/\s/g, '');
      phoneNumber = phoneNumber.replace(/(?:-)(\d)/g, '$1'); // remove "-" char preceding a digit
      phoneNumber = phoneNumber.replace(/(?:\.)(\d)/g, '$1'); // remove "." char preceding a digit
      phoneNumber = phoneNumber.replace(/(?:\()(\d+)(?:\))/g, '$1'); // remove parenthesis around digits

      if (phonePrefix) {
        const alternativePhonePrefix = `00${phonePrefix.replace('+', '')}`;
        if (startsWith(phoneNumber, alternativePhonePrefix)) {
          phoneNumber = `${phonePrefix}${phoneNumber.slice(alternativePhonePrefix.length)}`;
        }
      }
    }
    return phoneNumber;
  }

  /**
   *  Convert a given nic to contact.
   *  @param  {Object} nic               The nic to convert.
   *  @param  {Object} contactProperties The full list of contact properties.
   *  @return {Object}                   The options for creating new contact from nic informations
   */
  static convertNicToContact(nic, contactProperties) {
    const contact = {};
    let nicVal;

    forIn(contactProperties, (propertyValue) => {
      if (propertyValue.name === 'birthDay') {
        if (new RegExp(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/).test(nic.birthDay)) {
          const splittedDate = nic.birthDay.split('/');
          set(contact, 'birthDay', splittedDate.reverse().join('-'));
        } else {
          set(contact, 'birthDay', null);
        }
      } else {
        nicVal = get(
          nic,
          getMappedKey(propertyValue.name, propertyValue.path),
          get(nic, getMappedKey(propertyValue.name, propertyValue.path).toLowerCase(), null),
        );
        set(contact, propertyValue.path, nicVal);
      }
    });

    return contact;
  }

  /**
   *  Try to find a contact that match a nic (the nic needs to be transformed to contact).
   *  @param  {Object} transformedNic A nic transformed to contact.
   *  @param  {Array}  contacts       A list of contacts to search into.
   *  @return {Object}                A contact that match the transformed nic.
   *                                  If none found, an instance of OvhContact
   *                                  with nic informations.
   */
  static findMatchingContactFromNic(transformedNic, contacts) {
    let contact = null;

    contact = find(contacts, (contactParam) => {
      const copiedContact = angular.copy(contactParam);
      copiedContact.id = null;
      return isEqual(transformedNic, copiedContact);
    });

    return contact || transformedNic;
  }

  /**
   *  Get the properties for creating a contact object.
   *  @param  {Object} apiSchemas The /me API schema Object.
   *  @return {Object}            The entire properties for creating a contact object.
   */
  static getContactProperties(apiSchemas) {
    const properties = {};

    const contactProperties = get(apiSchemas, 'models["contact.Contact"].properties');
    const contactAddressProperties = get(apiSchemas, 'models["contact.Address"].properties');

    // take the POST operations parameters as the API schema allows null value and POST not...
    // first find the /me/contact path into /me schema
    const meContactApi = find(apiSchemas.apis, {
      path: '/me/contact',
    });

    // and take the POST API parameters of /me/contact
    const postParams = find(meContactApi.operations, {
      httpMethod: 'POST',
    }).parameters;

    const modifyContactProperty = (propertyValue) => {
      const contactProperty = angular.copy(propertyValue);
      const postProp = find(postParams, { name: contactProperty.name });
      if (postProp) {
        contactProperty.required = postProp.required;
      } else {
        contactProperty.required = !contactProperty.canBeNull;
      }

      // remove no more necessary properties of contactProperty
      delete contactProperty.canBeNull;
      delete contactProperty.readOnly;

      return contactProperty;
    };

    // iterate over contact.Contact model
    forIn(contactProperties, (propertyValue, propertyKey) => {
      // do nothing with address
      if (propertyKey === 'address') {
        return;
      }

      set(properties, propertyKey, merge({
        name: propertyKey,
        path: propertyKey,
      }, modifyContactProperty(propertyValue)));
    });

    // do the same for contact.Address model
    // except that there is no post rules for these properties
    forIn(contactAddressProperties, (propertyValue, propertyKey) => {
      set(properties, `['address.${propertyKey}']`, merge({
        name: propertyKey,
        path: `address.${propertyKey}`,
      }, modifyContactProperty(propertyValue)));
    });

    return properties;
  }

  /**
   *  Merge the contact properties with /newAccount/rules.
   *  @param  {Object} contactProperties    An object containing the contact creation properties.
   *  @param  {Object} nicCreationRules     An object containing the nic creation rules.
   *  @param  {Array}  predefinedProperties An array containing the list of contact
   *                                        creation fields.
   *  @param  {Object} initialValues        An object containing some initial values
   *                                        for the contact.
   *  @return {Object}                      An object with necessary fields for contact creation.
   */
  static mergeContactPropertiesWithCreationRules(
    contactProperties, nicCreationRules, predefinedProperties, initialValues,
  ) {
    const creationRules = {};

    // first add phoneCountry property
    const copiedContactProps = angular.copy(contactProperties);
    const phoneCountryProp = angular.copy(copiedContactProps['address.country']);
    phoneCountryProp.name = 'phoneCountry';
    phoneCountryProp.path = 'phoneCountry';
    phoneCountryProp.description = 'Phone country';
    set(copiedContactProps, 'phoneCountry', phoneCountryProp);

    // then merge each contactProperties with its associated nic creation rule
    forIn(copiedContactProps, (propertyValue) => {
      const contactRule = angular.copy(propertyValue);
      const isPhoneCountry = contactRule.name === 'phoneCountry';
      if (isPhoneCountry || includes(predefinedProperties, contactRule.path)) {
        const nicRule = get(
          nicCreationRules,
          getMappedKey(propertyValue.name, propertyValue.path),
          get(
            nicCreationRules,
            getMappedKey(propertyValue.name, propertyValue.path).toLowerCase(),
          ),
        );

        if (nicRule) {
          // set default value from nicRule to contactRule
          set(contactRule, 'defaultValue', nicRule.defaultValue);
          // set initial value from initialValues param
          set(contactRule, 'initialValue', get(initialValues, contactRule.name));
          // set regular expression from nicRule to contactRule
          set(contactRule, 'regularExpression', nicRule.regularExpression);
          // set prefix from nicRule to contactRule
          set(contactRule, 'prefix', nicRule.prefix);
          // set example from nicRule to contactRule
          set(contactRule, 'examples', nicRule.examples);

          if (size(nicRule.in) && contactRule.fullType === 'string') {
            set(contactRule, 'enum', nicRule.in);
          }

          // set contactRule to creationRules list
          set(creationRules, `['${contactRule.path}']`, contactRule);
        }
      }
    });

    return creationRules;
  }
}
