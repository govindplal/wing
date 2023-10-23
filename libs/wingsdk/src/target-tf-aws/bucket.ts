import { join } from "path";
import { ITerraformDependable } from "cdktf";
import { Construct } from "constructs";
import { App } from "./app";
import { Function as AWSFunction } from "./function";
import { Topic as AWSTopic } from "./topic";
import { S3Bucket } from "../.gen/providers/aws/s3-bucket";
import {
  S3BucketNotification,
  S3BucketNotificationTopic,
} from "../.gen/providers/aws/s3-bucket-notification";

import { S3BucketPolicy } from "../.gen/providers/aws/s3-bucket-policy";
import { S3BucketPublicAccessBlock } from "../.gen/providers/aws/s3-bucket-public-access-block";
import { S3Object } from "../.gen/providers/aws/s3-object";
import * as cloud from "../cloud";
import * as core from "../core";
import {
  CaseConventions,
  NameOptions,
  ResourceNames,
} from "../shared/resource-names";
import { calculateBucketPermissions } from "../shared-aws/permissions";
import { IInflightHost } from "../std";

const EVENTS = {
  [cloud.BucketEventType.DELETE]: ["s3:ObjectRemoved:*"],
  [cloud.BucketEventType.CREATE]: ["s3:ObjectCreated:Put"],
  [cloud.BucketEventType.UPDATE]: ["s3:ObjectCreated:Post"],
};

/**
 * Bucket prefix provided to Terraform must be between 3 and 37 characters.
 *
 * Bucket names are allowed to contain lowercase alphanumeric characters and
 * dashes (-). We generate names without dots (.) to avoid some partial
 * restrictions on bucket names with dots.
 */
export const BUCKET_PREFIX_OPTS: NameOptions = {
  maxLen: 37,
  case: CaseConventions.LOWERCASE,
  disallowedRegex: /([^a-z0-9\-]+)/g,
  // add a dash to the end of the prefix to distinguish between the
  // Wing-generated portion of the name and the suffix generated by Terraform
  suffix: "-",
};

/**
 * AWS implementation of `cloud.Bucket`.
 *
 * @inflight `@winglang/sdk.cloud.IBucketClient`
 */
export class Bucket extends cloud.Bucket {
  private readonly bucket: S3Bucket;
  private readonly public: boolean;
  private readonly notificationTopics: S3BucketNotificationTopic[] = [];
  private readonly notificationDependencies: ITerraformDependable[] = [];

  constructor(scope: Construct, id: string, props: cloud.BucketProps = {}) {
    super(scope, id, props);

    this.public = props.public ?? false;

    this.bucket = createEncryptedBucket(this, this.public);
  }

  public addObject(key: string, body: string): void {
    new S3Object(this, `S3Object-${key}`, {
      bucket: this.bucket.bucket,
      key,
      content: body,
    });
  }

  /** @internal */
  public _getInflightOps(): string[] {
    return [
      cloud.BucketInflightMethods.DELETE,
      cloud.BucketInflightMethods.GET,
      cloud.BucketInflightMethods.GET_JSON,
      cloud.BucketInflightMethods.LIST,
      cloud.BucketInflightMethods.PUT,
      cloud.BucketInflightMethods.PUT_JSON,
      cloud.BucketInflightMethods.PUBLIC_URL,
      cloud.BucketInflightMethods.EXISTS,
      cloud.BucketInflightMethods.TRY_GET,
      cloud.BucketInflightMethods.TRY_GET_JSON,
      cloud.BucketInflightMethods.TRY_DELETE,
      cloud.BucketInflightMethods.SIGNED_URL,
      cloud.BucketInflightMethods.METADATA,
    ];
  }

  protected eventHandlerLocation(): string {
    return join(__dirname, "bucket.onevent.inflight.js");
  }

  protected createTopic(actionType: cloud.BucketEventType): cloud.Topic {
    const handler = super.createTopic(actionType);

    // TODO: remove this constraint by adding generic permission APIs to cloud.Function
    if (!(handler instanceof AWSTopic)) {
      throw new Error("Topic only supports creating tfaws.Function right now");
    }

    handler.addPermissionToPublish(this, "s3.amazonaws.com", this.bucket.arn);

    this.notificationTopics.push({
      id: `on-${actionType.toLowerCase()}-notification`,
      events: EVENTS[actionType],
      topicArn: handler.arn,
    });

    this.notificationDependencies.push(handler.permissions);

    return handler;
  }

  public _preSynthesize() {
    super._preSynthesize();
    if (this.notificationTopics.length) {
      new S3BucketNotification(this, `S3BucketNotification`, {
        bucket: this.bucket.id,
        topic: this.notificationTopics,
        dependsOn: this.notificationDependencies,
      });
    }
  }

  public onLift(host: IInflightHost, ops: string[]): void {
    if (!(host instanceof AWSFunction)) {
      throw new Error("buckets can only be bound by tfaws.Function for now");
    }

    host.addPolicyStatements(
      ...calculateBucketPermissions(this.bucket.arn, ops)
    );

    // The bucket name needs to be passed through an environment variable since
    // it may not be resolved until deployment time.
    host.addEnvironment(this.envName(), this.bucket.bucket);

    super.onLift(host, ops);
  }

  /** @internal */
  public _toInflight(): string {
    return core.InflightClient.for(
      __dirname.replace("target-tf-aws", "shared-aws"),
      __filename,
      "BucketClient",
      [`process.env["${this.envName()}"]`]
    );
  }

  private envName(): string {
    return `BUCKET_NAME_${this.node.addr.slice(-8)}`;
  }
}

export function createEncryptedBucket(
  scope: Construct,
  isPublic: boolean,
  name: string = "Default"
): S3Bucket {
  const bucketPrefix = ResourceNames.generateName(scope, BUCKET_PREFIX_OPTS);

  // names cannot begin with 'xn--'
  if (bucketPrefix.startsWith("xn--")) {
    throw new Error("AWS S3 bucket names cannot begin with 'xn--'.");
  }

  // names must begin with a letter or number
  if (!/^[a-z0-9]/.test(bucketPrefix)) {
    throw new Error("AWS S3 bucket names must begin with a letter or number.");
  }

  // names cannot end with '-s3alias' and must end with a letter or number,
  // but we do not need to handle these cases since we are generating the
  // prefix only

  const isTestEnvironment = App.of(scope).isTestEnvironment;

  const bucket = new S3Bucket(scope, name, {
    bucketPrefix,
    forceDestroy: isTestEnvironment ? true : false,
  });

  if (isPublic) {
    const publicAccessBlock = new S3BucketPublicAccessBlock(
      scope,
      "PublicAccessBlock",
      {
        bucket: bucket.bucket,
        blockPublicAcls: false,
        blockPublicPolicy: false,
        ignorePublicAcls: false,
        restrictPublicBuckets: false,
      }
    );
    const policy = {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: "*",
          Action: ["s3:GetObject"],
          Resource: [`${bucket.arn}/*`],
        },
      ],
    };
    new S3BucketPolicy(scope, "PublicPolicy", {
      bucket: bucket.bucket,
      policy: JSON.stringify(policy),
      dependsOn: [publicAccessBlock],
    });
  }

  return bucket;
}
